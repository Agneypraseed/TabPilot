class TabPilotAttentionAlerts {
  constructor(api) {
    this.chrome = api;
    this.pending = new Map();
    this.creatingAudio = null;
    api.notifications?.onClicked?.addListener((id) => {
      const request = this.pending.get(id);
      if (!request) return;
      void (async () => {
        const tab = await api.tabs.get(request.tabId);
        await api.tabs.create({
          windowId: tab.windowId,
          url: api.runtime.getURL(
            `sidepanel.html?window=${tab.windowId}&tab=${request.tabId}`,
          ),
          active: true,
        });
      })().catch(() => {});
    });
  }
  async icon() {
    if (typeof OffscreenCanvas === "undefined")
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
    const canvas = new OffscreenCanvas(64, 64),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3459ee";
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(12, 17, 40, 31, 7);
    ctx.stroke();
    for (const x of [23, 32, 41]) {
      ctx.beginPath();
      ctx.arc(x, 27, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "white";
      ctx.fill();
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return (
      "data:image/png;base64," +
      btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))
    );
  }
  async sound() {
    const api = this.chrome;
    if (!api.offscreen?.createDocument || !api.runtime.getContexts)
      return false;
    try {
      if (!this.creatingAudio)
        this.creatingAudio = (async () => {
          const contexts = await api.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [api.runtime.getURL("attention-audio.html")],
          });
          if (!contexts.length)
            await api.offscreen.createDocument({
              url: "attention-audio.html",
              reasons: ["WORKERS", "AUDIO_PLAYBACK"],
              justification:
                "Host the browser agent worker and play optional task attention sounds.",
            });
        })().finally(() => {
          this.creatingAudio = null;
        });
      await this.creatingAudio;
      return (
        (
          await api.runtime.sendMessage({
            type: "tabpilot:play-attention-sound",
            target: "offscreen",
          })
        )?.played === true
      );
    } catch {
      return false;
    }
  }
  async update(state) {
    const requests = state.requests ?? [],
      current = new Set(requests.map((request) => request.id));
    try {
      await this.chrome.action?.setBadgeText({
        text: requests.length ? String(requests.length) : "",
      });
      if (requests.length)
        await this.chrome.action?.setBadgeBackgroundColor({ color: "#c57b21" });
    } catch {
      /* The request card remains available in limited hosts. */
    }
    for (const id of this.pending.keys())
      if (!current.has(id)) {
        this.pending.delete(id);
        void this.chrome.notifications?.clear(id).catch(() => {});
      }
    for (const request of requests) {
      if (this.pending.has(request.id)) continue;
      this.pending.set(request.id, request);
      try {
        await this.chrome.notifications?.create(request.id, {
          type: "basic",
          iconUrl: await this.icon(),
          title: "TabPilot needs your attention",
          message:
            "A browser task is waiting for your approval, help, or information.",
          requireInteraction: true,
          silent: !state.settings?.soundAlerts,
        });
      } catch {
        /* Embedded browsers may omit native notifications. */
      }
      if (!this.pending.has(request.id)) continue;
      const played =
        state.settings?.soundAlerts === false ? false : await this.sound();
      void this.chrome.runtime
        .sendMessage?.({
          type: "tabpilot:attention-alert",
          id: request.id,
          played,
        })
        .catch(() => {});
    }
  }
}
