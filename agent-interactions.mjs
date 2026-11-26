import { tool } from "@openai/agents";
import { z } from "zod";

export function humanHelpTool(requestHuman) {
  return tool({
    name: "request_user_help",
    description:
      "Pause this task for the user. Use handoff for CAPTCHAs, login, native dialogs, or consequential browser actions whose exact target or effect you cannot identify. Use information for a missing fact or choice. Identified consequential browser controls already have a tool approval check. Do not ask for routine searching, navigation, clicks or form preparation. Do not solve a CAPTCHA yourself. Describe the concrete action and include the observed page, recipient or item when relevant. The task waits for the user's reply.",
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

const errorResult = reason => ({ isError: true, content: [{ type: "text", text: reason }] });
const readTools = new Set(["browser_tabs", "browser_snapshot", "browser_screenshot", "browser_wait",
  "browser_focus", "browser_hover", "browser_download_status", "browser_download_local_status"]);
const activationKey = /(?:^|\+)(Enter|Space|Delete|Backspace| )$/i;
const verificationLabel = /^(i(?:'m| am) not a robot|verify (?:that )?you(?:'re| are) human)[.!?\s]*$/i;
const consequential = /^(?:post|archive)$|\b(pay|charge|purchase|buy|checkout|place (?:an? |the )?order|confirm (?:an? |the )?(?:order|payment|purchase|booking)|book now|delete|erase|permanently|send|publish|post (?:now|comment|reply)|sign (?:contract|agreement)|(?:accept|agree to) (?:contract|agreement|terms)|submit (?:application|order|payment|claim)|transfer (?:money|funds)|save (?:changes|settings|profile)|(?:change|reset) password|disable (?:security|two.factor)|(?:close|remove) (?:my |your |the )?(?:account|files?|records?))\b/i;

export function browserApprovalPolicy({ requestHuman, mode = "important", downloadDirectory, inspectApproval }) {
  const targets = new Map();
  const verificationPages = new Map();
  const dialogs = new Map();
  const pages = new Map();
  async function handoff(question, detail) {
    const result = await requestHuman({ kind: "handoff", question, detail });
    return errorResult(result.decision === "done"
      ? "The user handled the action in the browser. Do not execute the old proposed action; take a fresh snapshot before continuing."
      : "The user declined the handoff. Stop or ask for another approach.");
  }
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
      if (readTools.has(name)) return;
      const target = targets.get(args?.tabId)?.get(args?.ref);
      const observedLabel = target?.name || target?.role || (name === "browser_dialog" ? dialogs.get(args?.tabId)?.message : null);
      const manual = verificationLabel.test(observedLabel ?? "") || verificationPages.get(args?.tabId);
      if (manual && ["browser_click", "browser_fill", "browser_select", "browser_press", "browser_pointer"].includes(name)) {
        return handoff("Please handle the human-verification challenge in this browser tab.",
          "Choose Done after handling the challenge in the browser.");
      }
      const activation = name === "browser_click" || name === "browser_press" && (activationKey.test(args?.key ?? "") || consequential.test(observedLabel ?? "")) ||
        name === "browser_pointer" && args?.kind !== "hover" || name === "browser_dialog" && args?.accept;
      let live;
      if (inspectApproval && (activation || mode === "every-action")) {
        try { live = await inspectApproval(name, args); }
        catch (error) { return errorResult(error.message); }
        if (!live?.token) return errorResult("The browser could not identify the current action. Observe the page before trying again.");
        if (live.manual) return handoff("Please handle the human-verification challenge in this browser tab.",
          "Choose Done after handling the challenge in the browser.");
      }
      const label = live?.label || observedLabel || "the page";
      const important = (["browser_click", "browser_press"].includes(name) ||
        live && name === "browser_pointer" && args?.kind !== "hover" ||
        name === "browser_dialog" && args?.accept) && consequential.test(label);
      const page = live ?? pages.get(args?.tabId) ?? {};
      const details = live?.details ?? [];
      const recipients = live ? [...new Set(details.filter(item => item.kind === "recipient").map(item => item.value))] : page.recipients || [];
      const subject = live ? details.find(item => item.kind === "subject")?.value : page.subject;
      const amounts = [...new Set(details.filter(item => item.kind === "amount").map(item => item.value))];
      const messageSend = /^(send|send message|send email|send reply)$/i.test(label.trim());
      const moneyAction = /\b(pay|purchase|buy|charge|transfer (?:money|funds)|place (?:an? |the )?order|confirm (?:an? |the )?(?:purchase|payment))\b/i.test(label);
      let destination;
      if (["browser_navigate", "browser_open"].includes(name) && args?.url) {
        try { destination = new URL(args.url); } catch {}
      }
      const actionTarget = (live?.label && activation) || args?.ref ? `“${label}”`
        : name === "browser_pointer" ? `the control at image coordinates (${args.x}, ${args.y})`
        : destination ? `${destination.host}${destination.pathname.slice(0, 200)}` : "this tab";
      const description = name === "browser_press" ? `press ${args.key} on ${actionTarget}`
        : name === "browser_pointer" ? `${args.kind ?? "click"} ${actionTarget}`
        : name === "browser_navigate" ? `navigate to ${actionTarget}`
        : `${name.replace(/^browser_/, "").replaceAll("_", " ")} ${actionTarget}`;
      const unverifiedEffect = messageSend && !recipients.length || moneyAction && !amounts.length && !/[$€£¥]\s*\d/.test(label);
      const unsafeGesture = args?.clickCount > 1 || args?.kind === "drag" || args?.button && args.button !== "left";
      if (live && activation && (live.ambiguous || !live.search && !important && live.genericControl ||
          important && (live.incomplete || unverifiedEffect || unsafeGesture))) {
        const site = live.site ? ` on ${live.site}` : "";
        return handoff(`Please review and handle ${actionTarget}${site} in the browser.`,
          "TabPilot could not verify the exact effect. Choose Done after reviewing and handling the action yourself.");
      }
      if (mode !== "every-action" && !important) return live ? { approval: live.token } : undefined;
      const context = [
        page.title || page.site ? `Page: ${page.title || "Web page"}${page.site ? ` (${page.site})` : ""}` : "",
        `Action: ${messageSend ? "Send the prepared message" : description}`,
        (messageSend || moneyAction) && recipients.length ? `Visible recipient${recipients.length > 1 ? "s" : ""}: ${recipients.join(", ")}` : "",
        messageSend && subject ? `Subject: ${subject}` : "",
        amounts.length ? `Visible amount${amounts.length > 1 ? "s" : ""}: ${amounts.join(", ")}` : "",
        ...details.filter(item => item.kind === "item").map(item => `Visible item: ${item.value}`),
      ].filter(Boolean).join("\n");
      const result = await requestHuman({
        kind: "approval",
        question: messageSend ? recipients.length === 1 ? `Send the prepared message to ${recipients[0]}?` : "Send the prepared message?" : `Allow the agent to ${description}?`,
        detail:
          name === "browser_download_local" ? `Public link: ${args.url}\nLocal folder: ${downloadDirectory || "the folder configured in Settings"}\nFilename: ${args.filename || "chosen from the URL"}\nThis is a separate local transfer, without browser cookies or sign-in credentials. Existing files are preserved.` : name === "browser_download" ? `URL: ${args.url}\nDestination: ${args.saveAs ? "Choose a location in Chrome's Save As dialog" : `Downloads/${args.filename || "(filename from the server)"}`}\nThis starts one download. Chrome may ask you to choose a location; handle that dialog in the browser. The agent cannot accept dangerous-download warnings or open the file.` : `${context}\nReview the prepared content before approving. Approval applies to this action only. Declining pauses the task.`,
      });
      if (result.decision !== "approve") return errorResult("The user declined this action. Do not retry it. Ask for a different approach or stop.");
      return live ? { approval: live.token } : undefined;
    },
  };
}
