"use client";

import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

/**
 * Renders user-written markdown. Raw HTML is skipped and the output is
 * sanitised, so stored content can never inject markup or scripts; links open
 * in a new tab without passing the referrer.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed space-y-3 break-words [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_a]:text-[var(--primary)] [&_a]:underline [&_code]:bg-[var(--muted)] [&_code]:px-1 [&_code]:rounded [&_pre]:bg-[var(--muted)] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--muted-foreground)] [&_img]:max-w-full [&_img]:rounded-lg [&_table]:w-full [&_th]:text-left [&_th]:border-b [&_th]:border-[var(--border)] [&_td]:border-b [&_td]:border-[var(--border)] [&_td]:py-1 [&_hr]:border-[var(--border)]">
      <ReactMarkdown
        skipHtml
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
