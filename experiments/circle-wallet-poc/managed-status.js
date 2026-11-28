export const terminal = new Set(['verified', 'reverted', 'rejected', 'expired']);

export const isUnresolved = record => Boolean(record && !terminal.has(record.status));
