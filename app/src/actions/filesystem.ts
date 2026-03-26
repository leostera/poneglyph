import { ipc } from "@/ipc/manager";

export function selectDirectory(defaultPath?: string) {
  return ipc.client.shell.selectDirectory({
    defaultPath,
  });
}
