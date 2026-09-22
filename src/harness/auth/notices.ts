import type { AuthNotice } from "../contracts/index.ts";

export const CHATGPT_SUBSCRIPTION_NOTICE: AuthNotice = {
  id: "chatgpt-subscription",
  text:
    "You are signing in with your ChatGPT account. Synorch sends requests to OpenAI's Codex backend under your plan's " +
    "usage limits; no API bill is created. This access relies on OpenAI's public support for third-party clients, not " +
    "a written contract, and may change. Do not share your account and do not expose Synorch as a service to others.",
  requiresAcknowledgement: true,
};

export const CLAUDE_BRIDGE_NOTICE: AuthNotice = {
  id: "claude-bridge-experimental",
  text:
    "Experimental: Synorch will run the Claude Code installed on this computer and signed in by you. Synorch never sees, " +
    "reads or stores your Claude credentials. Anthropic restricts subscription use by third-party products: this usage may " +
    "draw from paid 'extra usage' instead of your plan, or be blocked by Anthropic. The definitive, supported path is a " +
    "Claude API key (`syn login anthropic --method api-key`).",
  requiresAcknowledgement: true,
};

export const API_KEY_BILLING_NOTICE: AuthNotice = {
  id: "api-key-billing",
  text: "Requests made with this API key are billed to your API account. The key is kept in Synorch's credential store.",
  requiresAcknowledgement: false,
};

export function plaintextCredentialNotice(filePath: string): AuthNotice {
  return {
    id: "plaintext-credential-file",
    text:
      `No OS keychain is available, so credentials are stored unencrypted in ${filePath} (file mode 0600, directory 0700). ` +
      "Anyone who can read files as your user can read them.",
    requiresAcknowledgement: false,
  };
}
