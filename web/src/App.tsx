/**
 * App.tsx — the harness-workflow app shell.
 *
 * The single-page application's outer structure: a header naming the product
 * above a main content region. The run configuration form (ticket #32) mounts
 * into <main>; the lane components and the run lifecycle mount alongside it
 * in ticket #33.
 *
 * Styling is Tailwind utilities only (the old flat stylesheet is deleted);
 * the existing look is converted to utility classes as the components land.
 */
import { RunConfigForm } from "./RunConfigForm.tsx";

export function App() {
	return (
		<div className="min-h-screen bg-slate-100 text-slate-900">
			<header className="border-b border-slate-200 bg-white">
				<div className="mx-auto max-w-5xl px-6 py-4">
					<h1 className="text-xl font-semibold tracking-tight">
						harness-workflow
					</h1>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-6 py-6">
				<RunConfigForm />
				{/* The two lanes and the run lifecycle mount here (#33). */}
			</main>
		</div>
	);
}
