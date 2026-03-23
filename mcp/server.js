
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import admin from "firebase-admin";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend or root
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../../.env.local") });

// --- FIREBASE INIT ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

// Import handlers AFTER firebase init to avoid "No App" error
const { performAudit } = await import("./handlers/audit.js");
const { performResearch } = await import("./handlers/research.js");

const db = admin.firestore();

const server = new Server(
  { name: "moodbiz-mcp-server", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } }
);

// --- RESOURCES ---
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "moodbiz://brands", name: "Brands List", mimeType: "application/json" },
    { uri: "moodbiz://brand/{id}/guidelines", name: "Brand Guidelines", mimeType: "text/markdown" },
    { uri: "moodbiz://brand/{id}/products", name: "Brand Products", mimeType: "application/json" }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === "moodbiz://brands") {
    const snap = await db.collection("brands").get();
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(snap.docs.map(d => ({ id: d.id, ...d.data() })), null, 2) }] };
  }
  const guidelineMatch = uri.match(/^moodbiz:\/\/brand\/([^/]+)\/guidelines$/);
  if (guidelineMatch) {
    const snap = await db.collection("brand_guidelines").where("brand_id", "==", guidelineMatch[1]).where("status", "==", "approved").get();
    let text = "";
    for (const doc of snap.docs) {
      const chunks = await doc.ref.collection("chunks").get();
      chunks.forEach(c => text += c.data().text + "\n\n");
    }
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }
  throw new Error("Resource not found");
});

// --- TOOLS ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "audit_content",
      description: "Audit text for brand consistency and logic",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          brand_id: { type: "string" },
          platform: { type: "string" }
        },
        required: ["text", "brand_id"]
      }
    },
    {
      name: "research_topic",
      description: "Research a topic using provided URLs",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          urls: { type: "array", items: { type: "string" } }
        },
        required: ["urls"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "audit_content") {
      const res = await performAudit(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (name === "research_topic") {
      const res = await performResearch(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
  throw new Error("Tool not found");
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
