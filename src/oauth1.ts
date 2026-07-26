import { createHmac, randomBytes } from "node:crypto";

/**
 * Minimal OAuth 1.0a (HMAC-SHA1) request signing.
 *
 * Why this exists alongside the OAuth2 flow already in x-client.ts: X's media
 * upload endpoint needs a `media.write` scope that this account's OAuth2 token
 * does not carry (its granted scope list has tweet.write, users.read, etc. but
 * no media.*). Re-authorising to add it would rotate the refresh token and risk
 * breaking the working posting path. The account DOES already hold OAuth 1.0a
 * consumer/access credentials, and 1.0a user-context is the long-standing,
 * still-supported auth for media upload - so media goes up over 1.0a and the
 * tweet itself still posts over OAuth2. media_id is scoped to the user, not the
 * auth method, so the two compose.
 *
 * No dependency added: node's crypto is enough for HMAC-SHA1.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/**
 * RFC 3986 percent-encoding. encodeURIComponent leaves ! * ( ) ' unescaped,
 * and OAuth signatures are byte-exact - missing these silently produces a
 * signature mismatch that reads as a generic 401.
 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*()']/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the Authorization header for a signed request.
 *
 * `extraParams` must contain any QUERY-STRING parameters, and for
 * application/x-www-form-urlencoded bodies the body params too. It must NOT
 * contain multipart/form-data body fields - those are deliberately excluded
 * from the signature base string by the spec, and including them is the
 * classic reason a chunked media upload 401s on APPEND while INIT succeeded.
 */
export function buildAuthHeader(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  extraParams: Record<string, string> = {},
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .map((k) => [percentEncode(k), percentEncode(allParams[k])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(
    creds.accessTokenSecret,
  )}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}
