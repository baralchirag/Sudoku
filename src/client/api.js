// Thin client for the Worker API. Errors surface as ApiError with the
// server's message so views can show it directly.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, body) {
  let res;
  try {
    res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'You appear to be offline.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  daily: (date) => request(`/api/daily?date=${encodeURIComponent(date)}`),
  start: (params) => request('/api/session', params),
  hint: (token, board) => request('/api/hint', { token, board }),
  submit: (payload) => request('/api/submit', payload),
  leaderboard: (date, level) => request(`/api/leaderboard/${date}/${level}`),
};
