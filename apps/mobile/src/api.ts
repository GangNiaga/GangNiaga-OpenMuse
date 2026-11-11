import { Platform } from "react-native";
import { readApiPayload } from "./api-response";

declare const __DEV__: boolean;

function resolveApiUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/$/, "");
  }
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    return (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787").replace(
      /\/$/,
      "",
    );
  }
  return "";
}

export const API_URL = resolveApiUrl();

function assertApiUrl(): string {
  if (!API_URL) {
    throw new Error(
      "Configuration error: EXPO_PUBLIC_API_URL is missing. Production builds require a configured API URL.",
    );
  }
  return API_URL;
}

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const baseUrl = assertApiUrl();
    const response = await fetch(`${baseUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await readApiPayload<T>(response);
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL || ""}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const baseUrl = assertApiUrl();
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await readApiPayload<{ token: string; mode: "sample" | "live" }>(
    response,
    "Could not open your workspace.",
  );
  return payload;
}
