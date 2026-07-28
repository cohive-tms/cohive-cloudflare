// フロントエンド側 Service Worker (sw.js) v1- バックグラウンドでのプッシュ通知受信と処理

self.addEventListener('push', (event) => {
  let data = {
    title: 'Cohive',
    body: '新しいメッセージを受信しました。',
    linkUrl: '/'
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (err) {
      data.body = event.data.text();
    }
  }

  const match = data.linkUrl ? data.linkUrl.match(/\/channels\/([^\/\?]+)/) : null;
  const channelId = match ? match[1] : null;

  const promiseChain = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    let hasActiveClient = false;
    for (const client of clientList) {
      // フロントエンドにメッセージ受信を通知
      client.postMessage({
        type: 'PUSH_RECEIVED',
        channelId: channelId,
        linkUrl: data.linkUrl
      });
      if (client.focused) {
        hasActiveClient = true;
      }
    }

    // すでにチャット画面をアクティブに開いている場合は、OS通知を省略する
    if (!hasActiveClient) {
      const options = {
        body: data.body,
        data: {
          linkUrl: data.linkUrl
        },
        vibrate: [100, 50, 100],
        tag: 'cohive-notification', // 同じタグの通知は自動的にグループ化/上書きされる
        renotify: true
      };
      return self.registration.showNotification(data.title, options);
    }
  });

  event.waitUntil(promiseChain);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let linkUrl = event.notification.data?.linkUrl || '/';

  // 相対パスの場合は、明示的にService Workerのoriginを付与して絶対URL化（予期せぬAPIドメイン等への遷移を完全防止）
  if (linkUrl.startsWith('/')) {
    linkUrl = new URL(linkUrl, self.location.origin).toString();
  }

  console.log('[ServiceWorker] Notification clicked. Opening URL:', linkUrl);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 既にアプリのタブが開いている場合は、そこへフォーカスしてURLへ遷移
      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            if ('navigate' in focusedClient) {
              return focusedClient.navigate(linkUrl);
            }
          });
        }
      }
      // 開いていなければ新しくタブを開く
      if (self.clients.openWindow) {
        return self.clients.openWindow(linkUrl);
      }
    })
  );
});

// 新しいSWが有効化された際に即座に制御を開始する
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// フロントエンドからの更新メッセージを待ち受け、即座に待機状態をスキップする
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// PWAインストール可能要件を満たすためのダミーのfetchイベントリスナ
self.addEventListener('fetch', (event) => {
  // 必要に応じて将来的に静的アセットのキャッシュ戦略などをここに追加可能です
});
