import { Button } from '@/components/ui/button'

function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-4 border-b pb-6">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Bruh</p>
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
              Pi-native personal agent on Cloudflare
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
              This app is being rebuilt around Pi, Durable Objects, and R2-backed memory.
              The initial focus is a lightweight chat UI, session orchestration at the edge,
              and durable memory tools for notes, summaries, and personal context.
            </p>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="border bg-card p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Edge
            </p>
            <h2 className="mb-2 text-lg font-medium">Worker + Session DOs</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Session creation, command ordering, SSE fanout, replay, and durable object-based
              coordination.
            </p>
          </article>

          <article className="border bg-card p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Runtime
            </p>
            <h2 className="mb-2 text-lg font-medium">Pi SDK host</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              A sandbox/container runtime that embeds Pi directly via the SDK and exposes agent
              actions to the edge layer.
            </p>
          </article>

          <article className="border bg-card p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Memory
            </p>
            <h2 className="mb-2 text-lg font-medium">R2-backed object tools</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Early custom tools for durable notes, profiles, session summaries, and other personal
              memory.
            </p>
          </article>
        </section>

        <section className="flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium">Current phase</h3>
            <p className="text-sm text-muted-foreground">
              Bootstrapping the monorepo, web app, edge worker, and runtime service.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" disabled>
              Sessions UI coming soon
            </Button>
            <Button disabled>Chat UI coming soon</Button>
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
