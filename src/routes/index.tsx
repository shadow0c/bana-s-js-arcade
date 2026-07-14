import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Index,
  head: () => ({
    meta: [
      { title: 'CS Clone - 3D Çok Oyunculu Shooter' },
      { name: 'description', content: 'Tarayıcıda çalışan 3D çok oyunculu arena shooter.' },
      { property: 'og:title', content: 'CS Clone - 3D Çok Oyunculu Shooter' },
      { property: 'og:description', content: 'Tarayıcıda çalışan 3D çok oyunculu arena shooter.' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
});

function Index() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-white">
      <div className="text-center">
        <h1 className="mb-2 text-5xl font-black tracking-tighter sm:text-7xl">
          <span className="text-orange-500">CS</span>{' '}
          <span className="text-blue-500">CLONE</span>
        </h1>
        <p className="mb-8 text-lg text-gray-400">Three.js tabanlı 3D çok oyunculu arena shooter</p>
        <Link
          to="/game"
          className="inline-flex items-center justify-center rounded-xl bg-green-600 px-8 py-4 text-xl font-bold transition hover:bg-green-500"
        >
          OYNA
        </Link>
      </div>

      <div className="mt-12 grid max-w-2xl gap-4 text-sm text-gray-500 sm:grid-cols-2">
        <div className="rounded-lg bg-white/5 p-4">
          <strong className="block text-white">Kontroller</strong>
          WASD hareket, Mouse nişan, Sol tık ateş, Sağ tık scope, R reload
        </div>
        <div className="rounded-lg bg-white/5 p-4">
          <strong className="block text-white">Silahlar ve Ekonomi</strong>
          Glock, AK-47, AWP. Kill başına $300 kazan, B ile satın al menüsünü aç
        </div>
      </div>
    </div>
  );
}
