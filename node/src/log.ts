export function log(message: string) {
  console.log(`[grid-node ${new Date().toISOString().slice(11, 19)}] ${message}`);
}
