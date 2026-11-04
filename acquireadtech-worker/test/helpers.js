import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** fetch stub: route(url) -> string body | {status} | Error */
export function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = route(String(url));
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && r.status) return new Response("", { status: r.status });
    return new Response(r ?? "");
  };
  fn.calls = calls;
  return fn;
}
