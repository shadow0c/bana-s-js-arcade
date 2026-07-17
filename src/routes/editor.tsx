import { createFileRoute } from '@tanstack/react-router';
import { EditorPage } from '@/components/editor/EditorPage';

// Bu route OYUNCULARIN GÖRMEDİĞİ, ayrı bir sayfadır. `/game`'i mount eden
// hiçbir bileşen bu dosyayı import etmez; sadece harita/içerik üreten kişi
// tarayıcısında doğrudan /editor adresine giderek erişir.
export const Route = createFileRoute('/editor')({
  component: EditorRoute,
  head: () => ({
    meta: [
      { title: 'Sahne Editörü' },
      { name: 'description', content: 'Harita/seviye editörü - geliştirici aracı.' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
});

function EditorRoute() {
  return <EditorPage />;
}
