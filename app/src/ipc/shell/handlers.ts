import { os } from "@orpc/server";
import { dialog, shell } from "electron";
import { ipcContext } from "../context";
import { openExternalLinkInputSchema, selectDirectoryInputSchema } from "./schemas";

export const openExternalLink = os.input(openExternalLinkInputSchema).handler(({ input }) => {
  const { url } = input;
  shell.openExternal(url);
});

export const selectDirectory = os
  .use(ipcContext.mainWindowContext)
  .input(selectDirectoryInputSchema)
  .handler(async ({ context, input }) => {
    const result = await dialog.showOpenDialog(context.window, {
      defaultPath: input?.defaultPath,
      properties: ["openDirectory", "createDirectory"],
      title: "Select directory",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  });
