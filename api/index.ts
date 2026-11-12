import handler from "./_handler.ts";

export const runtime = "nodejs";

export default handler;
export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./_handler.ts";
