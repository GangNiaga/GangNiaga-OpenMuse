import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import {
  type ComputerState,
  computerIdentity,
  computerOutput,
  type DockerResult,
  type DockerRunner,
} from "./computer.ts";
import { desktopCommand, type E2BDesktopComputer } from "./computer-e2b-desktop.ts";
import type { ComputerProvider, Config } from "./config.ts";
import { AppError } from "./errors.ts";

export interface ComputerSession {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<DockerResult>;
  file(input: string, seconds: number, maxOutputBytes: number): Promise<DockerResult>;
  stop(): Promise<void>;
}
export interface ComputerBackend {
  provider: ComputerProvider;
  receipts: string;
  network: "enabled" | "disabled";
  state(owner: string): Promise<ComputerState>;
  start(owner: string): Promise<void>;
  stop(owner: string): Promise<void>;
  running(owner: string): Promise<ComputerSession>;
}
const controlTimeout = 10000;
const stopped = () => new AppError("Start the computer before using its terminal or files", 409);
const inspectionSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    User: z.string(),
    Labels: z.record(z.string(), z.string()).nullable(),
    Env: z.array(z.string()),
    Entrypoint: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
    WorkingDir: z.string(),
  }),
  HostConfig: z.object({
    ReadonlyRootfs: z.boolean(),
    Privileged: z.boolean(),
    CapDrop: z.array(z.string()).nullable(),
    CapAdd: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    NetworkMode: z.string(),
    Memory: z.number(),
    MemorySwap: z.number(),
    PidsLimit: z.number().nullable(),
    NanoCpus: z.number(),
    Binds: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    DeviceRequests: z.array(z.unknown()).nullable(),
    PortBindings: z.record(z.string(), z.unknown()).nullable(),
    PidMode: z.string(),
    IpcMode: z.string(),
    Tmpfs: z.record(z.string(), z.string()).nullable(),
    RestartPolicy: z.object({ Name: z.string() }),
  }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
  State: z.object({ Running: z.boolean() }),
});
type Inspection = z.infer<typeof inspectionSchema>;
export class DockerComputer implements ComputerBackend {
  readonly provider = "docker";
  readonly receipts = "computer-commands";
  readonly network = "disabled";
  constructor(
    private readonly config: Config,
    private readonly docker: DockerRunner,
  ) {}
  private image() {
    const image = this.config.computerImage ?? "openmuse-computer:local";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/.test(image))
      throw new AppError("COMPUTER_IMAGE is invalid", 503);
    return image;
  }
  private async checked(args: string[]) {
    const result = await this.docker(args, { timeoutMs: controlTimeout });
    if (result.timedOut)
      throw new AppError("Docker did not respond within 10 seconds. Check the Docker engine.", 503);
    if (result.interrupted || result.exitCode !== 0 || result.truncated)
      throw new AppError(
        "Docker operation failed. Check that the engine is running and the computer image is built locally.",
        503,
      );
    return result.stdout;
  }
  private async inspect(owner: string): Promise<Inspection | undefined> {
    const identity = computerIdentity(this.config, owner);
    const found = (
      await this.checked([
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${identity.container}$`,
        "--format",
        "{{.ID}}",
      ])
    ).trim();
    if (!found) return undefined;
    const raw = JSON.parse(await this.checked(["container", "inspect", identity.container]));
    const result = z.array(inspectionSchema).length(1).safeParse(raw);
    if (!result.success)
      throw new AppError("Computer isolation inspection failed; refusing to attach", 409);
    const c = result.data[0],
      h = c.HostConfig;
    const empty = (list: unknown[] | null) => !list?.length;
    const safe =
      c.Name === `/${identity.container}` &&
      c.Config.Image === this.image() &&
      c.Config.User === "1000:1000" &&
      c.Config.WorkingDir === "/workspace" &&
      Object.entries(identity.labels).every(([key, value]) => c.Config.Labels?.[key] === value) &&
      c.Config.Env.every((value) =>
        ["PATH", "HOME", "LANG", "NODE_VERSION", "YARN_VERSION"].includes(value.split("=")[0]),
      ) &&
      JSON.stringify(c.Config.Entrypoint) === '["/usr/bin/sleep"]' &&
      JSON.stringify(c.Config.Cmd) === '["infinity"]' &&
      h.ReadonlyRootfs &&
      !h.Privileged &&
      h.CapDrop?.includes("ALL") &&
      empty(h.CapAdd) &&
      h.SecurityOpt?.length === 1 &&
      h.SecurityOpt.includes("no-new-privileges") &&
      h.NetworkMode === "none" &&
      h.Memory > 0 &&
      h.Memory <= 536870912 &&
      h.MemorySwap === h.Memory &&
      h.PidsLimit !== null &&
      h.PidsLimit > 0 &&
      h.PidsLimit <= 128 &&
      h.NanoCpus > 0 &&
      h.NanoCpus <= 1000000000 &&
      empty(h.Binds) &&
      empty(h.Devices) &&
      empty(h.DeviceRequests) &&
      !Object.keys(h.PortBindings ?? {}).length &&
      h.PidMode === "" &&
      h.IpcMode === "private" &&
      h.RestartPolicy.Name === "no" &&
      Object.keys(h.Tmpfs ?? {}).length === 1 &&
      h.Tmpfs?.["/tmp"] === "rw,nosuid,nodev,noexec,size=67108864,mode=1777" &&
      c.Mounts.length === 1 &&
      c.Mounts[0].Type === "volume" &&
      c.Mounts[0].Name === identity.volume &&
      c.Mounts[0].Destination === "/workspace" &&
      c.Mounts[0].RW &&
      Object.keys(c.NetworkSettings.Networks).every((network) => network === "none");
    if (!safe)
      throw new AppError(
        "Computer ownership or isolation does not match this deployment; refusing to attach",
        409,
      );
    await this.verifyVolume(owner);
    return c;
  }
  private async verifyVolume(owner: string) {
    const identity = computerIdentity(this.config, owner);
    const parsed = z
      .array(
        z.object({
          Name: z.string(),
          Labels: z.record(z.string(), z.string()).nullable(),
          Driver: z.string(),
          Options: z.record(z.string(), z.unknown()).nullable(),
          Scope: z.string(),
        }),
      )
      .length(1)
      .safeParse(JSON.parse(await this.checked(["volume", "inspect", identity.volume])));
    if (!parsed.success) throw new AppError("Computer workspace ownership inspection failed", 409);
    const v = parsed.data[0];
    if (
      v.Name !== identity.volume ||
      v.Driver !== "local" ||
      v.Scope !== "local" ||
      Object.keys(v.Options ?? {}).length ||
      !Object.entries(identity.labels).every(([key, value]) => v.Labels?.[key] === value)
    )
      throw new AppError("Computer workspace ownership or isolation does not match", 409);
  }

  async state(owner: string): Promise<ComputerState> {
    const info = await this.inspect(owner);
    return !info ? "missing" : info.State.Running ? "running" : "stopped";
  }
  async start(owner: string) {
    const identity = computerIdentity(this.config, owner);
    const existing = await this.inspect(owner);
    if (existing) {
      if (!existing.State.Running) await this.checked(["container", "start", identity.container]);
      return;
    }
    const labels = Object.entries(identity.labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]);
    const volume = (
      await this.checked([
        "volume",
        "ls",
        "--filter",
        `name=^${identity.volume}$`,
        "--format",
        "{{.Name}}",
      ])
    ).trim();
    if (!volume) await this.checked(["volume", "create", ...labels, identity.volume]);
    await this.verifyVolume(owner);
    await this.checked([
      "container",
      "create",
      "--pull",
      "never",
      "--name",
      identity.container,
      ...labels,
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--ipc",
      "private",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--restart",
      "no",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
      "--mount",
      `type=volume,source=${identity.volume},target=/workspace`,
      "--env",
      "HOME=/workspace",
      "--env",
      "LANG=C.UTF-8",
      "--entrypoint",
      "/usr/bin/sleep",
      this.image(),
      "infinity",
    ]);
    await this.inspect(owner);
    await this.checked(["container", "start", identity.container]);
  }
  async stop(owner: string) {
    if ((await this.inspect(owner))?.State.Running)
      await this.checked([
        "container",
        "stop",
        "--time",
        "2",
        computerIdentity(this.config, owner).container,
      ]);
  }
  async running(owner: string): Promise<ComputerSession> {
    if ((await this.state(owner)) !== "running") throw stopped();
    const container = computerIdentity(this.config, owner).container;
    return {
      exec: (command, cwd, signal) =>
        this.docker(
          [
            "exec",
            "--user",
            "1000:1000",
            "--workdir",
            cwd,
            container,
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=2s",
            "30s",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            command,
          ],
          { timeoutMs: 35000, signal },
        ),
      file: (input, _seconds, maxOutputBytes) =>
        this.docker(
          [
            "exec",
            "-i",
            "--user",
            "1000:1000",
            container,
            "/usr/bin/timeout",
            "--kill-after=1s",
            "8s",
            "/usr/bin/python3",
            "-I",
            "/opt/openmuse/files.py",
          ],
          { timeoutMs: 10000, input, maxOutputBytes },
        ),
      stop: async () => {
        await this.checked(["container", "stop", "--time", "2", container]);
      },
    };
  }
}

export class DesktopComputerBackend implements ComputerBackend {
  readonly provider = "e2b-desktop";
  readonly receipts = "computer-desktop-commands";
  readonly network = "enabled";
  constructor(
    private readonly config: Config,
    private readonly desktop: E2BDesktopComputer,
  ) {}
  private labels(owner: string) {
    return computerIdentity(this.config, owner).labels;
  }
  state(owner: string) {
    return this.desktop.state(this.labels(owner));
  }
  start(owner: string) {
    return this.desktop.start(this.labels(owner));
  }
  stop(owner: string) {
    return this.desktop.stop(this.labels(owner));
  }
  async running(owner: string): Promise<ComputerSession> {
    const labels = this.labels(owner);
    const verified = await this.desktop.inspect(labels);
    if (verified?.state !== "running") throw stopped();
    return {
      exec: (command, cwd, signal) =>
        this.desktop.run(labels, desktopCommand(command), {
          cwd,
          timeoutMs: 35000,
          signal,
          verified,
        }),
      file: (input, seconds, maxOutputBytes) =>
        this.desktop.run(
          labels,
          `/usr/bin/timeout --kill-after=1s ${seconds}s /usr/bin/python3 -I /opt/openmuse/files.py`,
          {
            timeoutMs: (seconds + 2) * 1000,
            input,
            maxOutputBytes,
            propagateAttachError: true,
            verified,
          },
        ),
      stop: () => this.stop(owner),
    };
  }
}

export class LocalComputer implements ComputerBackend {
  readonly provider = "local";
  readonly receipts = "computer-local-commands";
  readonly network = "enabled";
  private readonly workspaceDir: string;

  constructor(private readonly config: Config) {
    this.workspaceDir = join(config.dataDir, "workspace");
  }

  private resolvePath(virtualPath: string): string {
    const normalized = posix.normalize(virtualPath);
    if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
      throw new AppError("Choose an absolute path inside /workspace", 422);
    }
    const relative = normalized === "/workspace" ? "." : normalized.slice("/workspace/".length);
    return join(this.workspaceDir, ...relative.split("/"));
  }

  async state(owner: string): Promise<ComputerState> {
    try {
      await access(this.workspaceDir);
      return "running";
    } catch {
      return "stopped";
    }
  }

  async start(owner: string): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
  }

  async stop(owner: string): Promise<void> {
    // Local workspace persists across stops
  }

  async running(owner: string): Promise<ComputerSession> {
    await this.start(owner);
    const workspaceDir = this.workspaceDir;
    const resolvePath = this.resolvePath.bind(this);

    return {
      exec: async (command: string, cwd: string, signal?: AbortSignal) => {
        let workingDir = workspaceDir;
        try {
          workingDir = resolvePath(cwd);
          await mkdir(workingDir, { recursive: true });
        } catch {
          workingDir = workspaceDir;
        }

        const output = computerOutput();
        const { result } = output;

        return new Promise<DockerResult>((resolve) => {
          let settled = false;
          const isWin = process.platform === "win32";
          const shell = isWin ? "powershell.exe" : "/bin/bash";
          const shellArgs = isWin
            ? ["-NoProfile", "-NonInteractive", "-Command", command]
            : ["--noprofile", "--norc", "-c", command];

          const child = spawn(shell, shellArgs, {
            cwd: workingDir,
            env: { ...process.env, HOME: workspaceDir },
            stdio: ["pipe", "pipe", "pipe"],
          });

          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(output.finish());
          };

          const abort = () => {
            result.interrupted = true;
            child.kill();
            finish();
          };

          const timer = setTimeout(() => {
            result.timedOut = true;
            child.kill();
            finish();
          }, 35000);

          child.stdout.on("data", output.stdout);
          child.stderr.on("data", output.stderr);
          child.on("error", (err) => {
            output.stderr(`Command failed: ${err.message}`);
            finish();
          });
          child.on("close", (code) => {
            result.exitCode = code;
            finish();
          });

          signal?.addEventListener("abort", abort, { once: true });
          child.stdin.end();
        });
      },

      file: async (input: string, _seconds: number, maxOutputBytes: number) => {
        try {
          const req = JSON.parse(input);
          const { path: virtualPath, operation, text } = req;
          const target = resolvePath(virtualPath);
          const relativePath = virtualPath;

          const resObj: any = { path: relativePath };

          if (operation === "mkdir") {
            await mkdir(target, { recursive: true });
          } else if (operation === "write") {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, text ?? "", "utf8");
          } else if (operation === "read") {
            const content = await readFile(target, "utf8");
            resObj.text = content;
          } else if (operation === "read_pdf") {
            const buf = await readFile(target);
            resObj.base64 = buf.toString("base64");
          } else if (operation === "list") {
            try {
              const dirents = await readdir(target, { withFileTypes: true });
              const entries = [];
              for (const dirent of dirents) {
                const fullItemPath = join(target, dirent.name);
                let itemSize = 0;
                try {
                  const s = await stat(fullItemPath);
                  itemSize = s.size;
                } catch {}
                entries.push({
                  name: dirent.name,
                  path:
                    relativePath === "/workspace"
                      ? `/workspace/${dirent.name}`
                      : `${relativePath}/${dirent.name}`,
                  type: dirent.isDirectory() ? "directory" : "file",
                  size: itemSize,
                });
              }
              entries.sort(
                (a, b) =>
                  (a.type !== "directory" ? 1 : 0) - (b.type !== "directory" ? 1 : 0) ||
                  a.name.localeCompare(b.name),
              );
              resObj.entries = entries;
            } catch (err: any) {
              if (err.code === "ENOENT") {
                await mkdir(target, { recursive: true });
                resObj.entries = [];
              } else {
                throw err;
              }
            }
          }

          return {
            stdout: JSON.stringify(resObj),
            stderr: "",
            exitCode: 0,
            timedOut: false,
            interrupted: false,
            truncated: false,
          };
        } catch (err: any) {
          return {
            stdout: "",
            stderr: err.message || String(err),
            exitCode: 1,
            timedOut: false,
            interrupted: false,
            truncated: false,
          };
        }
      },

      stop: async () => {},
    };
  }
}
