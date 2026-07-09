import { CredentialsStore } from "./credentials-store.js";

const BASE_URL = "https://api.twitter.com/2";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
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

  async getMe(): Promise<unknown> {
    const res = await this.authedFetch("/users/me");
    return res.json();
  }

  /** Posts a real, immediately-live tweet. No draft state, no undo. */
  async createTweet(text: string): Promise<unknown> {
    const res = await this.authedFetch("/tweets", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`createTweet failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}
