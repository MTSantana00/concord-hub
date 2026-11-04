// Service worker: faz o app ser instalável e mostra as notificações com o app fechado (push).
// Não guarda nada em cache (o chat precisa de internet).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // tudo continua indo direto para a rede

// Chegou um aviso do servidor (mensagem direta ou menção): mostra a notificação.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // aviso sem corpo legível: mostra o genérico
  }
  const isCall = data.kind === "call";
  event.waitUntil(
    self.registration.showNotification(data.title || "Concord Hub", {
      body: data.body || "",
      tag: data.tag, // mensagens da mesma conversa se juntam em uma notificação só
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // ligação: fica na tela até a pessoa mexer, vibra em ritmo de toque e avisa de novo se o mesmo aviso chegar
      ...(isCall ? { requireInteraction: true, renotify: true, vibrate: [300, 150, 300, 150, 300] } : {}),
    }),
  );
});

// Clicou na notificação: traz o app para a frente (ou abre se estava fechado).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) if ("focus" in w) return w.focus();
      return self.clients.openWindow("/");
    })(),
  );
});
