import { z } from "zod";
import { get_encoding, encoding_for_model, TiktokenModel } from "tiktoken";

type EncoderName =
  | "gpt2"
  | "r50k_base"
  | "p50k_base"
  | "p50k_edit"
  | "cl100k_base"
  | "o200k_base";

const knownEncodings: EncoderName[] = [
  "o200k_base",
  "cl100k_base",
  "p50k_base",
  "p50k_edit",
  "r50k_base",
  "gpt2",
];

const port = Number(process.env.PORT || process.env.UI_PORT || 4747);

// Cache encoders to avoid re-initializing WASM every request.
const encoderCache = new Map<string, ReturnType<typeof get_encoding>>();

function getEncoderByName(name: string) {
  const key = name;
  const cached = encoderCache.get(key);
  if (cached) return cached;
  const enc = get_encoding(name as EncoderName);
  encoderCache.set(key, enc);
  return enc;
}

function getEncoderByModel(model: string) {
  const key = `model:${model}`;
  const cached = encoderCache.get(key);
  if (cached) return cached;
  const enc = encoding_for_model(model as TiktokenModel);
  encoderCache.set(key, enc);
  return enc;
}

const countSchema = z.object({
  text: z.string(),
  encoding: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
});

async function serveStatic(pathname: string): Promise<Response | null> {
  // Map "/" -> public/index.html, else serve from public
  const publicRoot = new URL("../public/", import.meta.url);
  let fileUrl: URL;
  if (pathname === "/" || pathname === "") {
    fileUrl = new URL("index.html", publicRoot);
  } else {
    // strip leading /
    const rel = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    fileUrl = new URL(rel, publicRoot);
  }
  try {
    const file = Bun.file(fileUrl);
    if (!(await file.exists())) return null;
    return new Response(file);
  } catch {
    return null;
  }
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (pathname === "/encodings" && req.method === "GET") {
      return json({ encodings: knownEncodings });
    }

    if (pathname === "/count" && req.method === "POST") {
      const start = performance.now();
      const ct = req.headers.get("content-type") || "";
      let text = "";
      let encodingName: string | undefined;
      let modelName: string | undefined;
      let maxTokens = 1_000_000;

      if (ct.includes("application/json")) {
        const body = await req.json().catch(() => null);
        const parsed = countSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            { error: "Invalid request", details: parsed.error.flatten() },
            { status: 400 }
          );
        }
        text = parsed.data.text;
        encodingName = parsed.data.encoding;
        modelName = parsed.data.model;
        maxTokens = parsed.data.maxTokens ?? maxTokens;
      } else if (ct.includes("text/plain")) {
        text = await req.text();
      } else {
        // Allow no content-type with raw text
        try {
          text = await req.text();
        } catch {
          return json({ error: "Unsupported content type" }, { status: 415 });
        }
      }

      let enc;
      try {
        if (encodingName) enc = getEncoderByName(encodingName);
        else if (modelName) enc = getEncoderByModel(modelName);
        else enc = getEncoderByName("o200k_base");
      } catch (e) {
        return json({ error: String(e) }, { status: 400 });
      }

      // Tokenize and count
      const bytes = new TextEncoder().encode(text).byteLength;
      // Treat special-token-like substrings as normal text by default
      const tokens = enc.encode(text, undefined, []);
      const count = tokens.length;
      if (count > maxTokens) {
        return json(
          { error: `Token count ${count} exceeds maxTokens ${maxTokens}` },
          { status: 413 }
        );
      }

      const elapsedMs = Math.round(performance.now() - start);
      return json({
        count,
        encoding: encodingName ?? (modelName ? "(from model)" : "o200k_base"),
        bytes,
        elapsedMs,
      });
    }

    const staticRes = await serveStatic(pathname);
    if (staticRes) return staticRes;
    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `tiktoken UI running at http://localhost:${server.port} (encoders: ${knownEncodings.join(", ")})`
);


