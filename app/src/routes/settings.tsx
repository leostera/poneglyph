import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteAiProvider, getAiProviders, saveAiProvider } from "@/lib/poneglyph-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

function SettingsPage() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["ai-providers"],
    queryFn: getAiProviders,
  });
  const [displayName, setDisplayName] = useState("ChatGPT");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const provider = providersQuery.data?.[0];
    if (!provider) {
      return;
    }

    setDisplayName(provider.displayName);
    setBaseUrl(provider.baseUrl);
    setDefaultModel(provider.defaultModel);
    setApiKey("");
    setEnabled(provider.enabled);
  }, [providersQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      saveAiProvider("openai", displayName, baseUrl, defaultModel, apiKey, enabled),
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => deleteAiProvider(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
    },
  });

  const currentProvider = providersQuery.data?.[0] ?? null;

  return (
    <div className="min-h-full px-8 py-7">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-[28px] font-semibold tracking-tight">Settings</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Connect an AI provider for inference. This does not import your ChatGPT history. It only
            gives Poneglyph a model backend.
          </p>
        </header>

        {providersQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>Failed to load settings</AlertTitle>
            <AlertDescription>{providersQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <section className="rounded-[3px] border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="text-base font-semibold">AI Providers</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              `poneglyph-agent` uses this provider to answer messages and decide when to use graph
              tools.
            </p>
          </div>

          <div className="space-y-4 px-5 py-5">
            {providersQuery.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full rounded-[3px]" />
                <Skeleton className="h-10 w-full rounded-[3px]" />
                <Skeleton className="h-10 w-full rounded-[3px]" />
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 text-sm">
                <label className="font-medium" htmlFor="ai-provider-display-name">
                  Display name
                </label>
                <Input
                  id="ai-provider-display-name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </div>
              <div className="space-y-2 text-sm">
                <label className="font-medium" htmlFor="ai-provider-default-model">
                  Default model
                </label>
                <Input
                  id="ai-provider-default-model"
                  onChange={(event) => setDefaultModel(event.target.value)}
                  placeholder="gpt-4.1-mini"
                  value={defaultModel}
                />
              </div>
            </div>

            <div className="space-y-2 text-sm">
              <label className="font-medium" htmlFor="ai-provider-base-url">
                Base URL
              </label>
              <Input
                id="ai-provider-base-url"
                onChange={(event) => setBaseUrl(event.target.value)}
                value={baseUrl}
              />
            </div>

            <div className="space-y-2 text-sm">
              <label className="font-medium" htmlFor="ai-provider-api-key">
                API key{currentProvider?.hasApiKey ? " (leave empty to keep the existing key)" : ""}
              </label>
              <Input
                id="ai-provider-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                type="password"
                value={apiKey}
              />
            </div>

            <label className="flex items-center gap-3 text-sm">
              <input
                checked={enabled}
                className="accent-foreground"
                onChange={(event) => setEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>Enable this provider</span>
            </label>

            {saveMutation.error ? (
              <Alert variant="destructive">
                <AlertTitle>Failed to save provider</AlertTitle>
                <AlertDescription>{saveMutation.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <div className="text-sm text-muted-foreground">
                {currentProvider
                  ? `${currentProvider.displayName} is configured for local inference.`
                  : "No AI provider configured yet."}
              </div>
              <div className="flex items-center gap-2">
                {currentProvider ? (
                  <Button
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(currentProvider.id)}
                    size="sm"
                    variant="outline"
                  >
                    {deleteMutation.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                    Delete
                  </Button>
                ) : null}
                <Button
                  disabled={
                    saveMutation.isPending ||
                    displayName.trim().length === 0 ||
                    baseUrl.trim().length === 0 ||
                    defaultModel.trim().length === 0 ||
                    (!currentProvider && apiKey.trim().length === 0)
                  }
                  onClick={() => saveMutation.mutate()}
                  size="sm"
                >
                  {saveMutation.isPending ? <LoaderCircle className="animate-spin" /> : null}
                  Save provider
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});
