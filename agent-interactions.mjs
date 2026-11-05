import { tool } from "@openai/agents";
import { z } from "zod";

export function humanHelpTool(requestHuman) {
  return tool({
    name: "request_user_help",
    description:
      "Pause this task for the user. Use handoff for CAPTCHAs, login, native dialogs or actions only the user can perform; information for a missing fact or choice; approval for a consequential visual or contextual action that the ordinary labeled-button approval check cannot identify. Do not ask for routine searching, navigation, clicks or form preparation. Clearly labeled consequential buttons already have a tool approval check. Do not solve or bypass a CAPTCHA yourself. Describe the exact action and consequence in the question and include the observed page, recipient or item in detail when relevant; avoid vague permission requests. The task waits and receives the user's actual reply before continuing.",
    parameters: z.object({
      kind: z.enum(["handoff", "information", "approval"]),
      question: z.string().min(1).max(3000),
      detail: z.string().max(6000),
    }),
    execute: async (request) => {
      const result = await requestHuman(request);
      return JSON.stringify({
        ...result,
        instruction:
          result.decision === "deny"
            ? "The user declined. Do not repeat this request or perform the declined action."
            : "User replied. Re-observe the page before acting; do not reuse old refs after a handoff.",
      });
    },
    errorFunction: null,
  });
}

export function browserApprovalPolicy({ requestHuman, mode = "important", downloadDirectory }) {
  const targets = new Map();
  const verificationPages = new Map();
  const dialogs = new Map();
  const pages = new Map();
  const consequential = /\b(pay|purchase|buy|checkout|place (?:an? |the )?order|confirm (?:an? |the )?(?:order|payment|purchase|booking)|book now|delete|erase|permanently|send|publish|post (?:now|comment|reply)|sign (?:contract|agreement)|accept (?:contract|agreement)|transfer (?:money|funds)|(?:change|reset) password|disable (?:security|two.factor)|(?:close|remove) (?:my |your |the )?(?:account|files?|records?))\b/i;
  return {
    afterTool(name, args, result) {
      const snapshot =
        result.structuredContent?.snapshot ?? result.structuredContent;
      if(snapshot && (snapshot.elements || snapshot.title || snapshot.url)) {
        const previous = pages.get(args?.tabId) || {};
        let site = previous.site;
        try { if(snapshot.url) {const url = new URL(snapshot.url);site = /^https?:$/.test(url.protocol) ? url.host : undefined;} } catch {}
        const fields = snapshot.elements?.filter(element=>element.type !== "password" && element.value && element.value !== "[redacted]") || [];
        const recipients = fields.filter(element=>/^(to|recipient|recipients|send to|email to|recipient email)$/i.test(element.name?.trim() || "")).map(element=>String(element.value).slice(0,160));
        const subject = fields.find(element=>/^(subject|email subject)$/i.test(element.name?.trim() || ""))?.value;
        pages.set(args?.tabId, {title:snapshot.title?.slice(0,160) || previous.title,site,
          ...(snapshot.elements ? {recipients:[...new Set(recipients)].slice(0,3),subject:subject?.slice(0,180)} : {recipients:previous.recipients,subject:previous.subject})});
      }
      if (snapshot?.elements)
        targets.set(
          args?.tabId,
          new Map(snapshot.elements.map((element) => [element.ref, element])),
        );
      if (snapshot && typeof snapshot === "object" && (snapshot.elements || snapshot.dialog))
        dialogs.set(args?.tabId, snapshot.dialog);
      if (typeof snapshot?.text === "string") verificationPages.set(args?.tabId,
        snapshot.text.length < 2500 && /(^|\n)\s*(verify (?:that )?you(?:'re| are) human|complete (?:the )?captcha|i(?:'m| am) not a robot)[.!?\s]*(\n|$)/im.test(snapshot.text));
    },
    async beforeTool(name, args) {
      const read = [
        "browser_tabs",
        "browser_snapshot",
        "browser_screenshot",
        "browser_wait",
        "browser_focus",
        "browser_hover",
        "browser_download_status",
        "browser_download_local_status",
      ].includes(name);
      if (read) return;
      const target = targets.get(args?.tabId)?.get(args?.ref);
      const label = target?.name || target?.role || (name === "browser_dialog" ? dialogs.get(args?.tabId)?.message : null) || "the page";
      const manual = /^(i(?:'m| am) not a robot|verify (?:that )?you(?:'re| are) human)[.!?\s]*$/i.test(label) || verificationPages.get(args?.tabId);
      if (manual && ["browser_click", "browser_fill", "browser_select", "browser_press", "browser_pointer"].includes(name)) {
        const response = await requestHuman({ kind: "handoff", question: "Please handle the human-verification challenge in this browser tab.", detail: "The agent will not click or solve the challenge. Choose Done only after you have handled it in the browser." });
        return { isError: true, content: [{ type: "text", text: response.decision === "done" ? "The user handled verification. Do not execute the old proposed action; take a fresh snapshot before continuing." : "The user declined the verification handoff. Stop or ask for another approach." }] };
      }
      const important =
        (["browser_click", "browser_press"].includes(name) && consequential.test(label)) ||
        (name === "browser_dialog" && args?.accept === true && consequential.test(label));
      if (mode !== "every-action" && !important) return;
      const description = `${name.replace(/^browser_/, "")} ${args?.ref ? `“${label}”` : name === "browser_press" ? `“${args.key}” in this tab` : name === "browser_pointer" ? `at image coordinates (${args.x}, ${args.y})` : "in this tab"}`;
      const page = pages.get(args?.tabId) || {};
      const recipients = page.recipients || [];
      const messageSend = /^(send|send message|send email|send reply)$/i.test(label.trim()) &&
        (/mail|message|compose|outlook/i.test(`${page.title || ""} ${page.site || ""}`) || (recipients.length && page.subject));
      const context = [
        page.title || page.site ? `Page: ${page.title || "Web page"}${page.site ? ` (${page.site})` : ""}` : "",
        `Action: ${messageSend ? "Send the prepared message" : description}`,
        messageSend && recipients.length ? `Visible recipient${recipients.length > 1 ? "s" : ""}: ${recipients.join(", ")}` : "",
        messageSend && page.subject ? `Subject: ${page.subject}` : "",
      ].filter(Boolean).join("\n");
      const result = await requestHuman({
        kind: "approval",
        question: messageSend ? recipients.length === 1 ? `Send the prepared message to ${recipients[0]}?` : "Send the prepared message?" : `Allow the agent to ${description}?`,
        detail:
          name === "browser_download_local" ? `Public link: ${args.url}\nLocal folder: ${downloadDirectory || "the folder configured in Settings"}\nFilename: ${args.filename || "chosen from the URL"}\nThis is a separate local transfer, without browser cookies or sign-in credentials. Existing files are preserved.` : name === "browser_download" ? `URL: ${args.url}\nDestination: ${args.saveAs ? "Choose a location in Chrome's Save As dialog" : `Downloads/${args.filename || "(filename from the server)"}`}\nThis starts one download. Chrome may ask you to choose a location; handle that dialog in the browser. The agent cannot accept dangerous-download warnings or open the file.` : `${context}\nReview the prepared content in the browser before approving. This approves one action. Declining pauses the task.`,
      });
      if (result.decision !== "approve")
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "The user declined this action. Do not retry it. Ask for a different approach or stop.",
            },
          ],
        };
    },
  };
}
