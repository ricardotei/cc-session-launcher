import { Action, ActionPanel, Form, Icon } from "@raycast/api";
import { startNewDesktopSession } from "../core/handoff";
import { tildify } from "../core/format";
import { closeWithHUD, runAction } from "./helpers";

interface NewSessionFormProps {
  repoRoot: string;
  repoName: string;
}

/** Asks for an optional first prompt, then starts a new Claude desktop session in the repo. */
export function NewSessionForm({ repoRoot, repoName }: NewSessionFormProps) {
  async function handleSubmit(values: Form.Values) {
    const prompt = typeof values.prompt === "string" ? values.prompt.trim() : "";
    await runAction("Could not start a new session", async () => {
      await startNewDesktopSession(repoRoot, prompt || undefined);
      await closeWithHUD("Claude will ask to confirm the folder");
    });
  }

  return (
    <Form
      navigationTitle={`New Session in ${repoName}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Session" icon={Icon.Plus} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Folder" text={tildify(repoRoot)} />
      <Form.TextArea id="prompt" title="Prompt" placeholder="Optional first message for Claude" />
    </Form>
  );
}
