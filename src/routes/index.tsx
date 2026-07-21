import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Index,
  head: () => ({
    meta: [
      { title: 'CS 2 Mobile' },
      { name: 'description', content: 'CS 2 Mobile: Beta sürümü.' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
});

function Index() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-neutral-950 px-4 text-white">
      <div className="text-center">
        <h1 className="mb-2 text-5xl font-black tracking-tighter sm:text-7xl">
          <span className="text-orange-500">CS 2</span>{' '}
          <span className="text-blue-500">MOBILE</span>
        </h1>
        <p className="mb-8 text-lg text-gray-400">Tarayıcıda CS 2 Multi-player</p>
        <Link
          to="/game"
          className="inline-flex items-center justify-center rounded-xl bg-green-600 px-8 py-4 text-xl font-bold transition hover:bg-green-500"
        >
          OYNA
        </Link>
      </div>
    </div>
  );
}

