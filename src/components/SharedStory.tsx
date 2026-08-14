import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { DOMSerializer, Node as PMNode } from "prosemirror-model";

import { schema } from "@/lib/schema";
import { openShare, type OpenedShare, type SharedStory as Story } from "@/lib/share";
import { ThemeToggle } from "./ThemeToggle";

/**
 * A shared story, read by anyone holding its link. No account, no vault, no
 * sync engine — and no Loro: the payload is plain prose JSON, so this page's
 * chunk stays a fraction of the editor's. The key comes out of the URL
 * fragment, which the browser never sent to the server; decryption is the
 * first and only thing that happens to the payload after it arrives.
 */
export function SharedStory() {
  const { shareId } = useParams<{ shareId: string }>();
  const [opened, setOpened] = useState<OpenedShare | null>(null);

  useEffect(() => {
    if (!shareId) return;
    let stale = false;
    // Read once, at open. The fragment is the key, not navigation state.
    const fragment = window.location.hash.slice(1);
    void openShare(shareId, fragment).then((result) => {
      if (!stale) setOpened(result);
    });
    return () => {
      stale = true;
    };
  }, [shareId]);

  const title = opened?.kind === "ok" ? opened.story.title : null;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  if (!shareId) return null;

  if (opened == null) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <span className="text-sm text-muted-foreground">Opening…</span>
      </div>
    );
  }

  if (opened.kind !== "ok") {
    return <ShareTrouble result={opened} />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <header
        className="mx-auto flex max-w-[41rem] items-start justify-between px-6 pt-10"
        style={{ paddingTop: "calc(2.5rem + env(safe-area-inset-top, 0px))" }}
      >
        <div>
          <h1 className="font-prose text-3xl tracking-tight">
            {opened.story.title}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            A story shared from{" "}
            <a href="/" className="underline underline-offset-2">
              Layton
            </a>
          </p>
        </div>
        <ThemeToggle className="text-muted-foreground" />
      </header>
      <StoryProse story={opened.story} />
    </div>
  );
}

/**
 * Every way a link can fail, told apart, because each asks the reader for a
 * different next move — and none of them is "sign in".
 */
function ShareTrouble({ result }: { result: Exclude<OpenedShare, { kind: "ok" }> }) {
  const [heading, body] =
    result.kind === "missing"
      ? [
          "This story is no longer shared.",
          "The link may have been revoked by its author, or it never existed.",
        ]
      : result.kind === "bad-key" || result.kind === "bad-link"
        ? [
            "This link is incomplete.",
            "The part after the # is the key that opens the story, and it did not survive the journey. Ask for the link again, and copy all of it.",
          ]
        : [
            "The story could not be fetched.",
            result.message || "Check your connection and reload this page.",
          ];

  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="font-prose text-xl tracking-tight">{heading}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/**
 * The prose itself, serialized straight from ProseMirror JSON to DOM with the
 * same schema the editor writes with — so bold, scene breaks and headings come
 * out exactly as they went in, and the existing .prose-surface typesetting
 * applies unchanged.
 *
 * Built imperatively into one container on purpose: the typesetting rules
 * (`h2 + p` flush-left, first-paragraph indent suppression) are adjacency
 * selectors, and any per-chapter wrapper element would break them.
 */
function StoryProse({ story }: { story: Story }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const serializer = DOMSerializer.fromSchema(schema);
    const out = document.createDocumentFragment();

    story.chapters.forEach((chapter, index) => {
      const title = typeof chapter.title === "string" ? chapter.title.trim() : "";
      if (title) {
        const heading = document.createElement("h2");
        heading.textContent = title;
        out.appendChild(heading);
      } else if (index > 0) {
        // An untitled chapter still needs its boundary marked, and the scene
        // break is already the book's own way of drawing one.
        const hr = document.createElement("hr");
        hr.className = "scene-break";
        out.appendChild(hr);
      }
      if (chapter.body == null) return;
      try {
        const node = PMNode.fromJSON(schema, chapter.body);
        out.appendChild(serializer.serializeFragment(node.content));
      } catch (err) {
        // One unreadable chapter should not take the rest of the story down.
        console.warn("Could not render a shared chapter", err);
      }
    });

    el.replaceChildren(out);
  }, [story]);

  return <div ref={ref} className="prose-surface reading" />;
}
