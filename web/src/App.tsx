/**
 * App.tsx — the harness-workflow app shell.
 *
 * The single-page application's outer structure: a header naming the product
 * above a main content region. The run configuration form, the model and
 * workspace selectors, the lane components, and the run lifecycle mount into
 * <main> in later tickets (#32 run configuration form, #33 run lifecycle).
 *
 * Styling is Tailwind utilities only (the old flat stylesheet is deleted);
 * the existing look is converted to utility classes as the components land.
 */
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
				{/* The run configuration form and the two lanes mount here (#32, #33). */}
			</main>
		</div>
	);
}
