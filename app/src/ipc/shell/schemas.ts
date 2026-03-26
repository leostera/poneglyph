import z from "zod";

export const openExternalLinkInputSchema = z.object({
  url: z.url(),
});

export const selectDirectoryInputSchema = z
  .object({
    defaultPath: z.string().optional(),
  })
  .default({});
