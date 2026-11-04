chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message.type !== "tabpilot:play-attention-sound" ||
    message.target !== "offscreen" ||
    sender.id !== chrome.runtime.id
  )
    return false;
  tabPilotAttentionTone().then((played) => respond({ played }));
  return true;
});
