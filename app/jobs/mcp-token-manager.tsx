'use client';

import { useActionState } from 'react';
import { issueJobsMcpToken, revokeJobsMcpToken, type McpTokenActionState } from './actions';

const initialState: McpTokenActionState = {};
type Token = { id: string; label: string; expiresAt: string; expired: boolean; revokedAt: string | null; createdAt: string };

export default function McpTokenManager({ tokens }: { tokens: Token[] }) {
  const [state, action, pending] = useActionState(issueJobsMcpToken, initialState);
  return <section className="jobsPanel jobsTokenPanel" aria-labelledby="mcp-token-heading">
    <h2 id="mcp-token-heading">Local MCP connection</h2>
    <p>Create a 90-day bearer token for the local job-hunt MCP. Copy it into your Mac Keychain setup, then close this page. The token appears once.</p>
    <form action={action} className="jobsFormGrid">
      <label>Token label<input name="label" maxLength={80} defaultValue="Local job-hunt MCP" /></label>
      <div><button className="jobsButtonPrimary" type="submit" disabled={pending}>{pending ? 'Creating token…' : 'Create MCP token'}</button></div>
    </form>
    {state.message ? <p role={state.error ? 'alert' : 'status'} aria-live="polite">{state.message}</p> : null}
    {state.token ? <label className="jobsOneTimeToken">New token — copy it now<textarea readOnly rows={3} value={state.token} onFocus={(event) => event.currentTarget.select()} /></label> : null}
    <h3>Existing tokens</h3>
    {tokens.length ? <ul className="jobsTokenList">{tokens.map((token) => {
      const inactive = Boolean(token.revokedAt) || token.expired;
      const expiry = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/Chicago' }).format(new Date(token.expiresAt));
      return <li key={token.id}><div><strong>{token.label}</strong><span>{inactive ? 'Revoked or expired' : `Expires ${expiry}`}</span></div>
        {!inactive ? <form action={revokeJobsMcpToken}><input type="hidden" name="id" value={token.id} /><button type="submit">Revoke</button></form> : null}</li>;
    })}</ul> : <p>No MCP tokens have been issued.</p>}
  </section>;
}
