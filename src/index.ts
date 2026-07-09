#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CredentialsStore } from "./credentials-store.js";
import { XClient } from "./x-client.js";

const CREDENTIALS_FILE = process.env.X_CREDENTIALS_FILE;
if (!CREDENTIALS_FILE) {
  console.error("X_CREDENTIALS_FILE environment variable is required (path to the credentials .env file)");
  process.exit(1);
}

const store = new CredentialsStore(CREDENTIALS_FILE);
const client = new XClient(store);

const tools: Tool[] = [
  {
    name: "x_get_me",
    description: "Get the authenticated X (Twitter) user's basic profile",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "x_create_tweet",
    description:
      "Post a real, immediately-live tweet. There is no draft/undo - only call this after the content " +
      "has already been approved through the fleet board's HITL review, never before.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The tweet text (280 char limit enforced by X)" },
      },
      required: ["text"],
    },
  },
];

const server = new Server({ name: "x-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result: unknown;

  switch (name) {
    case "x_get_me":
      result = await client.getMe();
      break;
    case "x_create_tweet":
      result = await client.createTweet(args.text as string);
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("x-mcp server running on stdio");
