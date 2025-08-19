import { z } from "zod";
import { get_encoding, encoding_for_model, TiktokenModel } from "tiktoken";
import { spawn } from "child_process";
import { promises as fs, existsSync } from "fs";
import { join, resolve, relative } from "path";
import { glob } from "glob";
import ignore from "ignore";

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

const contextGenerateSchema = z.object({
  files: z.array(z.string()),
  template: z.string().optional(),
  instruction: z.string().optional(),
  encoding: z.string().optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
});

const completePromptSchema = z.object({
  files: z.array(z.string()),
  userInstructions: z.string(),
  metaPrompts: z.array(z.object({
    name: z.string(),
    content: z.string()
  })).optional(),
  encoding: z.string().optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
});

const changeRepoSchema = z.object({
  path: z.string(),
});

// Repository Context Builder functionality
class RepoContextAPI {
  private repoPath: string;
  
  constructor(repoPath: string = process.cwd()) {
    // Prefer explicit env var, then provided arg, then current working directory
    if (process.env.REPO_PATH) {
      this.repoPath = resolve(process.env.REPO_PATH);
    } else if (repoPath) {
      this.repoPath = resolve(repoPath);
    } else {
      this.repoPath = process.cwd();
    }
    console.log(`Repository path set to: ${this.repoPath}`);
  }

  get repositoryPath() {
    return this.repoPath;
  }

  setRepositoryPath(newPath: string) {
    const resolvedPath = resolve(newPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }
    this.repoPath = resolvedPath;
    console.log(`Repository path changed to: ${this.repoPath}`);
    return this.repoPath;
  }

  async loadIgnorePatterns() {
    const ig = ignore();
    
    // Add common ignore patterns
    ig.add([
      'node_modules/',
      '.git/',
      '.DS_Store',
      '*.log',
      'dist/',
      'build/',
      'coverage/',
      '.nyc_output/',
      '*.tmp',
      '*.temp',
      '__pycache__/',
      '*.pyc',
      '.pytest_cache/',
    ]);

    // Load .gitignore
    const gitignorePath = join(this.repoPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
      ig.add(gitignoreContent);
    }

    return ig;
  }

  async listFiles(patterns: string[] = ['**/*']) {
    const ig = await this.loadIgnorePatterns();
    const allFiles = [];

    try {
      // Use a more conservative glob pattern to avoid stack overflow
      const globOptions = {
        cwd: this.repoPath,
        nodir: true,
        dot: true,       // Include dot files/folders like .claude
        follow: false,   // Don't follow symlinks
        maxDepth: 10,    // Limit depth to prevent stack overflow
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/coverage/**',
          '**/__pycache__/**',
          '**/venv/**',
          '**/target/**',
          '**/.turbo/**',
          '**/.yarn/**',
          '**/bower_components/**',
          '**/.cache/**',
          '**/.npm/**',
          '**/.pnpm/**'
        ]
      };

      // Try to glob with the pattern, but catch errors
      for (const pattern of patterns) {
        try {
          const matches = await glob(pattern, globOptions);
          // Add matches in smaller chunks to avoid stack overflow
          for (let i = 0; i < matches.length; i += 100) {
            allFiles.push(...matches.slice(i, i + 100));
          }
        } catch (patternError) {
          console.error(`Error with pattern ${pattern}:`, patternError);
          // Continue with other patterns
        }
      }
    } catch (error) {
      console.error('Error listing files:', error);
      // Return empty array if glob completely fails
      return [];
    }

    // Remove duplicates and apply ignore patterns
    const uniqueFiles = [...new Set(allFiles)]
      .filter(file => !ig.ignores(file))
      .sort();

    return uniqueFiles;
  }

  generateFileTree(files: string[]) {
    const tree: any = {};
    
    files.forEach(file => {
      const parts = file.split('/');
      let current = tree;
      
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          // File
          if (!current._files) current._files = [];
          current._files.push(part);
        } else {
          // Directory
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      });
    });

    return tree;
  }

  formatFileTreeString(files: string[]) {
    // Create a simple string representation of file tree
    const tree: any = {};
    
    files.forEach(file => {
      const parts = file.split('/');
      let current = tree;
      
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          if (!current._files) current._files = [];
          current._files.push(part);
        } else {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      });
    });

    const formatNode = (node: any, prefix = '', isLast = true, path = ''): string => {
      let result = '';
      const entries = Object.entries(node).filter(([k]) => k !== '_files');
      const files = node._files || [];
      
      // Format directories
      entries.forEach(([name, subtree], index) => {
        const isLastEntry = index === entries.length - 1 && files.length === 0;
        const symbol = isLastEntry ? '└── ' : '├── ';
        const nextPrefix = prefix + (isLastEntry ? '    ' : '│   ');
        
        result += `${prefix}${symbol}${name}/\n`;
        result += formatNode(subtree as any, nextPrefix, isLastEntry, path ? `${path}/${name}` : name);
      });
      
      // Format files
      files.forEach((file: string, index: number) => {
        const isLastFile = index === files.length - 1;
        const symbol = isLastFile ? '└── ' : '├── ';
        result += `${prefix}${symbol}${file}\n`;
      });
      
      return result;
    };

    return formatNode(tree);
  }

  countTokens(text: string, encoding: string = 'cl100k_base') {
    const enc = getEncoderByName(encoding);
    const tokens = enc.encode(text, undefined, []);
    return tokens.length;
  }

  async runPromptCode(files: string[], options: { template?: string; instruction?: string } = {}) {
    return new Promise<{ output: string; tokens: number }>((resolve, reject) => {
      const args = ['generate'];
      
      // Add files
      files.forEach(file => {
        args.push('-f', file);
      });

      // Add template if specified
      if (options.template) {
        args.push('--template', options.template);
      }

      // Add custom instruction if specified
      if (options.instruction) {
        args.push('--instruction', options.instruction);
      }

      const child = spawn('promptcode', args, {
        cwd: this.repoPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ output: stdout, tokens: this.countTokens(stdout) });
        } else {
          reject(new Error(`PromptCode failed: ${stderr || stdout}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn PromptCode: ${error.message}`));
      });
    });
  }

  async generateContext(files: string[], options: { template?: string; instruction?: string; encoding?: string; maxTokens?: number } = {}) {
    const resolvedFiles = [];
    const missingFiles = [];

    // Resolve and validate files
    for (const file of files) {
      const fullPath = join(this.repoPath, file);
      if (existsSync(fullPath)) {
        resolvedFiles.push(file);
      } else {
        missingFiles.push(file);
      }
    }

    if (resolvedFiles.length === 0) {
      throw new Error('No valid files to process');
    }

    // Generate context using PromptCode
    const result = await this.runPromptCode(resolvedFiles, {
      template: options.template,
      instruction: options.instruction
    });
    
    // Add our own token counting
    const tiktokenCount = this.countTokens(result.output, options.encoding);
    const maxTokens = options.maxTokens || 128000;
    
    return {
      output: result.output,
      tokenCount: tiktokenCount,
      fileCount: resolvedFiles.length,
      isOverLimit: tiktokenCount > maxTokens,
      maxTokens,
      files: resolvedFiles,
      missingFiles,
      repoPath: relative(process.cwd(), this.repoPath)
    };
  }

  async generateCompletePrompt(
    files: string[], 
    userInstructions: string, 
    metaPrompts: Array<{ name: string; content: string }> = [],
    encoding: string = 'cl100k_base'
  ) {
    // Get all repository files for the file tree
    const allFiles = await this.listFiles();
    const fileTreeString = this.formatFileTreeString(allFiles);
    
    // Build the complete prompt in Repo Prompt format
    let completePrompt = '';
    
    // 1. File Tree
    completePrompt += '<file_map>\n';
    completePrompt += this.repoPath + '\n';
    completePrompt += fileTreeString;
    completePrompt += '</file_map>\n\n';
    
    // 2. File Contents
    completePrompt += '<file_contents>\n';
    for (const file of files) {
      const fullPath = join(this.repoPath, file);
      if (existsSync(fullPath)) {
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          completePrompt += `File: ${file}\n`;
          completePrompt += '```\n';
          completePrompt += content;
          completePrompt += '\n```\n\n';
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }
    completePrompt += '</file_contents>\n\n';
    
    // 3. Meta Prompts
    metaPrompts.forEach((prompt, index) => {
      completePrompt += `<meta prompt ${index + 1} = "${prompt.name}">\n`;
      completePrompt += prompt.content;
      completePrompt += `\n</meta prompt ${index + 1}>\n\n`;
    });
    
    // 4. User Instructions
    completePrompt += '<user_instructions>\n';
    completePrompt += userInstructions;
    completePrompt += '\n</user_instructions>\n';
    
    // Count tokens
    const tokenCount = this.countTokens(completePrompt, encoding);
    
    return {
      prompt: completePrompt,
      tokenCount,
      fileCount: files.length,
      totalFiles: allFiles.length,
      metaPromptCount: metaPrompts.length
    };
  }
}

const repoAPI = new RepoContextAPI();

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

// Simple token count cache keyed by absolute file path with mtime/size validation
interface TokenCacheEntry {
  mtimeMs: number;
  size: number;
  tokens: number;
  encoding: string; // encoding used for this tokenization
}
const tokenCache: Map<string, TokenCacheEntry> = new Map();

async function getFileStatSafe(path: string) {
  try {
    const stat = await fs.stat(path);
    return stat;
  } catch {
    return null;
  }
}

async function getTokenCountForFile(fullPath: string, encoding: string, counter: (text: string, enc: string) => number) {
  const stat = await getFileStatSafe(fullPath);
  if (!stat) return 0;
  const key = fullPath;
  const cached = tokenCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.encoding === encoding) {
    return cached.tokens;
  }
  // Read and compute
  try {
    const content = await fs.readFile(fullPath, 'utf8');
    const tokens = counter(content, encoding);
    tokenCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, tokens, encoding });
    return tokens;
  } catch {
    return 0;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let i = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (_e) {
        // @ts-ignore
        results[idx] = undefined;
      }
    }
  };
  const n = Math.min(limit, Math.max(1, items.length));
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
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

    // Repository Context Builder API endpoints
    if (pathname === "/api/repo/files" && req.method === "GET") {
      try {
        const patterns = url.searchParams.get("patterns")?.split(",") || ["**/*"];
        const files = await repoAPI.listFiles(patterns);
        const tree = repoAPI.generateFileTree(files);
        return json({ files, tree, repoPath: relative(process.cwd(), repoAPI.repositoryPath) });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    if (pathname === "/api/repo/context" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => null);
        const parsed = contextGenerateSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            { error: "Invalid request", details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        const result = await repoAPI.generateContext(parsed.data.files, {
          template: parsed.data.template,
          instruction: parsed.data.instruction,
          encoding: parsed.data.encoding,
          maxTokens: parsed.data.maxTokens
        });

        return json(result);
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    // Complete prompt generation endpoint
    if (pathname === "/api/repo/complete-prompt" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => null);
        const parsed = completePromptSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            { error: "Invalid request", details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        const result = await repoAPI.generateCompletePrompt(
          parsed.data.files,
          parsed.data.userInstructions,
          parsed.data.metaPrompts || [],
          parsed.data.encoding || 'cl100k_base'
        );

        return json(result);
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    // Change repository endpoint
    if (pathname === "/api/repo/change" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => null);
        const parsed = changeRepoSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            { error: "Invalid request", details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        const newPath = repoAPI.setRepositoryPath(parsed.data.path);
        return json({ success: true, path: newPath });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    // List directories endpoint
    if (pathname === "/api/repo/directories" && req.method === "GET") {
      try {
        const basePath = url.searchParams.get("path") || repoAPI.repositoryPath;
        const resolvedPath = resolve(basePath);
        
        if (!existsSync(resolvedPath)) {
          return json({ error: "Path does not exist" }, { status: 404 });
        }
        
        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
        const directories = entries
          .filter(entry => entry.isDirectory())
          .filter(entry => !entry.name.startsWith('.'))
          .map(entry => ({
            name: entry.name,
            path: join(resolvedPath, entry.name)
          }));
        
        return json({ 
          currentPath: resolvedPath,
          parentPath: resolve(resolvedPath, '..'),
          directories,
          canGoUp: resolvedPath !== '/'
        });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    // Get current repository path
    if (pathname === "/api/repo/current" && req.method === "GET") {
      return json({ path: repoAPI.repositoryPath });
    }

    // Get token counts for specific files (cached + concurrent)
    if (pathname === "/api/repo/file-tokens" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => null);
        const files: string[] = body?.files || [];
        const encoding: string = body?.encoding || 'cl100k_base';

        const filePaths = files.map(f => ({ rel: f, abs: join(repoAPI.repositoryPath, f) }));

        const counts = await mapWithConcurrency(filePaths, 16, async ({ rel, abs }) => {
          if (!existsSync(abs)) return { rel, tokens: 0 };
          const tokens = await getTokenCountForFile(abs, encoding, (text, enc) => repoAPI.countTokens(text, enc));
          return { rel, tokens };
        });

        const tokenCounts: Record<string, number> = {};
        let totalTokens = 0;
        for (const c of counts) {
          if (!c) continue;
          tokenCounts[c.rel] = c.tokens;
          totalTokens += c.tokens;
        }

        return json({ tokenCounts, totalTokens, cached: true });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    const staticRes = await serveStatic(pathname);
    if (staticRes) return staticRes;
    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `tiktoken UI running at http://localhost:${server.port} (encoders: ${knownEncodings.join(", ")})`
);


