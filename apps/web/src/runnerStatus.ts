/** HTTP responses and SSE may arrive out of order; keep the newest server snapshot. */
export function mergeRunnerStatus(current:any,incoming:any) {
  if(!incoming?.queue||typeof incoming.queue.paused!=='boolean')return current;
  if((incoming.queue.observedAt??0)<(current?.queue?.observedAt??0))return current;
  return incoming;
}
export function dispatchLabel(status:any,fresh:boolean,pending:boolean) {
  return pending?'正在同步…':!fresh||!status?.queue?'同步状态中…':status.queue.paused?'恢复派发':'暂停派发';
}
/**
 * Presets are shown by the name their configuration declares (`displayName`), not by the file id the
 * run row stores (`preset-demo01`). Unknown tasks — a preset that has since been removed — fall back
 * to the stored id rather than showing nothing.
 */
export function taskLabel(task:string,tasks:any[]) {
  const match=Array.isArray(tasks)?tasks.find(candidate=>candidate?.name===task):undefined;
  return match?.displayName||task||'—';
}
