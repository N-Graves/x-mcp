#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CredentialsStore } from "./credentials-store.js";
import { XClient } from "./x-client.js";
import { requireCapability } from "./agent-capability.js";

const REQUIRED_CAPABILITY = "social"; // ECHO owns social posting

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
      "has already been approved through the fleet board's HITL review, never before. Requires agent_id " +
      "(must hold the 'social' capability, e.g. echo). Pass image_paths to attach up to 4 images - they " +
      "are uploaded to X first, so give local file paths (e.g. a MUSE render), NOT public URLs. " +
      "Pass in_reply_to_tweet_id to post a reply - that is how a product link reaches an audience " +
      "here: X cuts distribution on posts with an external URL in the body, so post the tweet " +
      "link-free, then call this again with the returned tweet id and the link.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        text: { type: "string", description: "The tweet text (280 char limit enforced by X)" },
        image_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 4 local image file paths (png/jpg/gif/webp, max 5MB each) to attach. " +
            "Uploaded to X before the tweet is posted.",
        },
        in_reply_to_tweet_id: {
          type: "string",
          description:
            "Reply to this tweet id instead of posting standalone. Use our own tweet's id " +
            "(from this tool's own response, data.id) to put the link in a self-reply.",
        },
      },
      required: ["agent_id", "text"],
    },
  },
  {
    name: "x_upload_media",
    description:
      "Upload one local image to X and return its media_id, without posting anything. Useful to verify " +
      "an image is accepted before composing the tweet. Most callers should just pass image_paths to " +
      "x_create_tweet instead. Requires agent_id (must hold the 'social' capability).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        image_path: { type: "string", description: "Local path to a png/jpg/gif/webp under 5MB" },
      },
      required: ["agent_id", "image_path"],
    },
  },
  {
    name: "x_delete_tweet",
    description:
      "Delete one of our own tweets. Irreversible - the tweet and its engagement are gone. Requires " +
      "agent_id (must hold the 'social' capability).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        tweet_id: { type: "string", description: "The id of the tweet to delete" },
      },
      required: ["agent_id", "tweet_id"],
    },
  },
  {
    name: "x_get_my_tweets",
    description:
      "List our own recent tweets with their public metrics (likes, reposts, replies, impressions). " +
      "Safe read - use it to check what actually posted and how it performed, rather than assuming a " +
      "post landed.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: {
          type: "number",
          description: "How many tweets to return (5-100, default 10)",
        },
      },
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
    case "x_create_tweet": {
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      const paths = (args.image_paths as string[] | undefined) ?? [];
      // Upload first so a bad/oversized image fails BEFORE anything goes live -
      // a tweet cannot be edited, only deleted, so a half-successful post with
      // missing media is worse than a clean upfront failure.
      const mediaIds: string[] = [];
      for (const p of paths) {
        mediaIds.push(await client.uploadMedia(p));
      }
      result = await client.createTweet(
        args.text as string,
        mediaIds,
        args.in_reply_to_tweet_id as string | undefined,
      );
      break;
    }
    case "x_upload_media":
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      result = { media_id: await client.uploadMedia(args.image_path as string) };
      break;
    case "x_delete_tweet":
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      result = await client.deleteTweet(args.tweet_id as string);
      break;
    case "x_get_my_tweets":
      result = await client.getMyTweets((args.max_results as number | undefined) ?? 10);
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("x-mcp server running on stdio");
