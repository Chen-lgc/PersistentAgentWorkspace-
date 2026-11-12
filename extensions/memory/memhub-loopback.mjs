// Read-only, single-user MemHub Hub API adapter. NOT integrated into Maus prompt yet.
// Deliberately return profile only: the upstream Hub's workspace recall may include facts
// from other projects and it uses a fixed user_id="default". No cross-tenant access here.
const MAX_QUERY_CHARS = 4000;
const MAX_MEMORY_CHARS = 2000;
export class MemhubLoopbackClient {
  constructor({baseURL='http://127.0.0.1:8765',token,fetchFn=fetch,timeoutMs=2500}) {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]','::1'].includes(url.hostname)) {
      throw new Error('MemHub adapter requires plaintext localhost only; do not send bearer credentials remotely.');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Hub baseURL must be its origin');
    }
    if (!token || typeof token !== 'string') throw new Error('MemHub local bearer token required');
    if (!(timeoutMs>0 && timeoutMs<=30_000)) throw new Error('Invalid timeout');
    this.origin = url.origin;
    this.token = token;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }
  async recallPersonal(query, {signal}={}) {
    if (typeof query!=='string' || !query.trim() || query.length>MAX_QUERY_CHARS) throw new Error('Invalid memory query');
    const timerSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([timerSignal, signal]) : timerSignal;
    const response = await this.fetchFn(`${this.origin}/v1/hub/recall`, {
      method:'POST',
      headers:{'Authorization':`Bearer ${this.token}`,'Content-Type':'application/json'},
      // Hub runs the semantic search only when limit>0 or procedure_limit>0.
      // Ask for one normal hit (discarded below) so its PROFILE lane actually runs.
      body:JSON.stringify({query,limit:1,raw_limit:0,procedure_limit:0}),
      signal:requestSignal,
    });
    if (!response.ok) throw new Error(`MemHub recall failed: HTTP ${response.status}`);
    const body = await response.json();
    const items = body?.memories?.profile;
    if (!Array.isArray(items)) throw new Error('Unexpected MemHub response shape');
    return items.slice(0,3).flatMap((item) => {
      const text = item?.content;
      const id = item?.memory_id;
      return typeof text === 'string' && typeof id === 'string'
        ? [{id,content:text.slice(0,MAX_MEMORY_CHARS),source:'memhub-profile',trustedAsInstruction:false}]
        : [];
    });
  }
}
