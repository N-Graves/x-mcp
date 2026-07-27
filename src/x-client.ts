import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { CredentialsStore } from "./credentials-store.js";
import { buildAuthHeader, type OAuth1Credentials } from "./oauth1.js";

const BASE_URL = "https://api.twitter.com/2";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
// X's own documented chunk ceiling is 5MB; stay under it with headroom.
const CHUNK_BYTES = 4 * 1024 * 1024;
// X rejects images over 5MB and GIFs over 15MB on this endpoint.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// Refresh proactively once less than this much of the token's life remains,
// rather than waiting for a 401 mid-call.
const REFRESH_MARGIN_SECONDS = 300;

export class XClient {
  private accessToken: string | null = null;
  private tokenObtainedAt = 0;
  private expiresInSeconds = 0;

  constructor(private readonly store: CredentialsStore) {}

  private async refresh(): Promise<void> {
    const clientId = this.store.get("OAUTH2_CLIENT_ID");
    const clientSecret = this.store.get("OAUTH2_CLIENT_SECRET");
    const refreshToken = this.store.get("OAUTH2_REFRESH_TOKEN");

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });

    if (!res.ok) {
      throw new Error(`X token refresh failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    this.accessToken = data.access_token;
    this.tokenObtainedAt = Date.now();
    this.expiresInSeconds = data.expires_in;

    // X rotates refresh tokens on every use - the old one is now dead, so
    // this write is not optional bookkeeping, it's required for the *next*
    // refresh to even be possible.
    this.store.setMany({
      OAUTH2_ACCESS_TOKEN: data.access_token,
      OAUTH2_REFRESH_TOKEN: data.refresh_token,
      OAUTH2_SCOPE: data.scope,
      OAUTH2_EXPIRES_IN_SECONDS: String(data.expires_in),
    });
  }

  private async ensureValidToken(): Promise<string> {
    const ageSeconds = (Date.now() - this.tokenObtainedAt) / 1000;
    const needsRefresh =
      !this.accessToken || ageSeconds >= this.expiresInSeconds - REFRESH_MARGIN_SECONDS;
    if (needsRefresh) {
      await this.refresh();
    }
    return this.accessToken!;
  }

  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureValidToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401) {
      // Token might have been invalidated out-of-band - refresh once and retry.
      await this.refresh();
      const retryToken = this.accessToken!;
      return fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${retryToken}`,
          "Content-Type": "application/json",
        },
      });
    }
    return res;
  }

  private oauth1(): OAuth1Credentials {
    return {
      consumerKey: this.store.get("OAUTH1_CONSUMER_KEY"),
      consumerSecret: this.store.get("OAUTH1_CONSUMER_SECRET"),
      accessToken: this.store.get("OAUTH1_ACCESS_TOKEN"),
      accessTokenSecret: this.store.get("OAUTH1_ACCESS_TOKEN_SECRET"),
    };
  }

  async getMe(): Promise<unknown> {
    const res = await this.authedFetch("/users/me");
    return res.json();
  }

  /**
   * Uploads one image and returns its media_id_string, ready to attach to a
   * tweet. Chunked INIT/APPEND/FINALIZE - the same path works for a 40KB PNG
   * and a large GIF, so there's no size-dependent branch to get wrong.
   *
   * Signed with OAuth 1.0a, not the OAuth2 token used everywhere else - see
   * oauth1.ts for why. Note APPEND is multipart, so its body fields are
   * deliberately NOT part of the signature base string.
   */
  async uploadMedia(filePath: string): Promise<string> {
    const bytes = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mediaType = MIME_BY_EXT[ext];
    if (!mediaType) {
      throw new Error(
        `unsupported image type ${ext || "(none)"} for ${basename(filePath)} - ` +
          `X accepts ${Object.keys(MIME_BY_EXT).join(", ")}`,
      );
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `${basename(filePath)} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB - ` +
          `X rejects images over ${MAX_IMAGE_BYTES / 1024 / 1024}MB on this endpoint`,
      );
    }
    const creds = this.oauth1();

    // INIT - form-urlencoded, so its params ARE signed.
    const initParams = {
      command: "INIT",
      total_bytes: String(bytes.length),
      media_type: mediaType,
      media_category: "tweet_image",
    };
    const initRes = await fetch(MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader("POST", MEDIA_UPLOAD_URL, creds, initParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(initParams),
    });
    if (!initRes.ok) {
      throw new Error(`media INIT failed: ${initRes.status} ${await initRes.text()}`);
    }
    const mediaId = ((await initRes.json()) as { media_id_string: string }).media_id_string;

    // APPEND - multipart; only the oauth_* params are signed.
    for (let i = 0, seg = 0; i < bytes.length; i += CHUNK_BYTES, seg++) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.length));
      const form = new FormData();
      form.append("command", "APPEND");
      form.append("media_id", mediaId);
      form.append("segment_index", String(seg));
      form.append("media", new Blob([chunk]), basename(filePath));

      const appendRes = await fetch(MEDIA_UPLOAD_URL, {
        method: "POST",
        headers: { Authorization: buildAuthHeader("POST", MEDIA_UPLOAD_URL, creds) },
        body: form,
      });
      if (!appendRes.ok) {
        throw new Error(
          `media APPEND segment ${seg} failed: ${appendRes.status} ${await appendRes.text()}`,
        );
      }
    }

    const finalizeParams = { command: "FINALIZE", media_id: mediaId };
    const finRes = await fetch(MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader("POST", MEDIA_UPLOAD_URL, creds, finalizeParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(finalizeParams),
    });
    if (!finRes.ok) {
      throw new Error(`media FINALIZE failed: ${finRes.status} ${await finRes.text()}`);
    }

    // An image finalises synchronously; only video/GIF return processing_info.
    const fin = (await finRes.json()) as {
      media_id_string: string;
      processing_info?: { state: string; error?: { message?: string } };
    };
    if (fin.processing_info?.state === "failed") {
      throw new Error(
        `media processing failed: ${fin.processing_info.error?.message ?? "unknown"}`,
      );
    }
    return fin.media_id_string;
  }

  /**
   * Posts a real, immediately-live tweet. No draft state, no undo.
   * `mediaIds` attaches already-uploaded media (see uploadMedia); X allows up
   * to 4 images per tweet.
   *
   * `inReplyToTweetId` makes this a reply rather than a standalone post. That
   * is how an outbound link is supposed to reach an X audience: X reduces
   * distribution on posts carrying an external URL in the body, so the post
   * itself stays link-free and the link goes in a self-reply. Replying to our
   * own tweet id is the normal case here, not an edge case.
   */
  async createTweet(
    text: string,
    mediaIds?: string[],
    inReplyToTweetId?: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { text };
    if (mediaIds && mediaIds.length > 0) {
      if (mediaIds.length > 4) {
        throw new Error(`X allows at most 4 images per tweet, got ${mediaIds.length}`);
      }
      body.media = { media_ids: mediaIds };
    }
    if (inReplyToTweetId) {
      body.reply = { in_reply_to_tweet_id: inReplyToTweetId };
    }
    const res = await this.authedFetch("/tweets", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`createTweet failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /** Deletes one of our own tweets. Irreversible. */
  async deleteTweet(tweetId: string): Promise<unknown> {
    const res = await this.authedFetch(`/tweets/${encodeURIComponent(tweetId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new Error(`deleteTweet failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Recent tweets from our own account, with public metrics - so an agent can
   * check what actually went out and how it did, rather than only being able
   * to write.
   */
  async getMyTweets(maxResults = 10): Promise<unknown> {
    const me = (await this.getMe()) as { data?: { id?: string } };
    const userId = me?.data?.id;
    if (!userId) {
      throw new Error("could not resolve own user id from /users/me");
    }
    const capped = Math.min(Math.max(maxResults, 5), 100);
    const res = await this.authedFetch(
      `/users/${userId}/tweets?max_results=${capped}` +
        `&tweet.fields=created_at,public_metrics,attachments`,
    );
    if (!res.ok) {
      throw new Error(`getMyTweets failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}
