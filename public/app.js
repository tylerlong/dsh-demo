(() => {
	var LANES = ["left", "right"];
	var state = { running: false, runElapsed: 0 };
	var laneTimers = { left: null, right: null };
	var laneSeconds = { left: 0, right: 0 };
	var laneRunning = { left: false, right: false };
	var runTimer = null;
	var ws = null;

	function el(id) {
		return document.getElementById(id);
	}

	// Populate the three model dropdowns from the harness-configured list.
	async function populateModelLists() {
		var res = await fetch("/api/models");
		var data = await res.json();
		var slots = [
			["primary", data.defaults.primary],
			["lane-left", data.defaults.left],
			["lane-right", data.defaults.right],
		];
		slots.forEach((slot) => {
			var id = slot[0],
				def = slot[1];
			var select = el(id + "-model");
			data.models.forEach((model) => {
				var option = document.createElement("option");
				option.value = model.id;
				option.textContent = model.name + " (" + model.provider + ")";
				select.appendChild(option);
				if (model.id === def) select.value = model.id;
			});
		});
	}

	// Populate the workspace dropdown from the shared catalog, preselecting the
	// workspace whose most recent session is newest.
	async function populateWorkspaceList() {
		var workspaces = await (await fetch("/api/workspaces")).json();
		var select = el("workspace");
		var preselect = -1;
		var newestAt = -1;
		workspaces.forEach((w, i) => {
			var option = document.createElement("option");
			option.value = w.path;
			option.textContent = w.title + " (" + w.path + ")";
			select.appendChild(option);
			if (
				typeof w.newestSessionAt === "number" &&
				w.newestSessionAt > newestAt
			) {
				newestAt = w.newestSessionAt;
				preselect = i;
			}
		});
		if (preselect >= 0) {
			select.selectedIndex = preselect;
		} else if (workspaces.length > 0) {
			select.selectedIndex = 0;
		}
		if (workspaces.length === 0) {
			el("workspace-hint").textContent =
				"No workspaces in the catalog yet — create one in DSH web. There is no path fallback.";
		}
		syncSubmitState();
	}

	// ---- per-lane status chips and elapsed timers ----
	function setLaneChip(lane, text, cls) {
		var chip = el("lane-" + lane + "-status");
		chip.textContent = text;
		chip.className = "status chip";
		if (cls) chip.className += " " + cls;
	}
	function clearLane(lane) {
		stopLaneTimer(lane);
		laneSeconds[lane] = 0;
		laneRunning[lane] = false;
		el("lane-" + lane + "-output").textContent = "";
		setLaneChip(lane, "", "");
	}
	function startLaneTimer(lane) {
		laneRunning[lane] = true;
		laneSeconds[lane] = 0;
		setLaneChip(lane, "running · 0s", "running");
		laneTimers[lane] = setInterval(() => {
			laneSeconds[lane] += 1;
			setLaneChip(lane, "running · " + laneSeconds[lane] + "s", "running");
		}, 1000);
	}
	function stopLaneTimer(lane) {
		if (laneTimers[lane]) {
			clearInterval(laneTimers[lane]);
			laneTimers[lane] = null;
		}
	}
	function finishLane(lane, status, cls) {
		var seconds = laneSeconds[lane] || 0;
		laneRunning[lane] = false;
		stopLaneTimer(lane);
		setLaneChip(lane, status + " · " + seconds + "s", cls);
	}

	// ---- run-level state: lock the inputs, drive a run-level timer ----
	function showRunStatus(text) {
		el("primary-status").textContent = text;
	}
	// The chosen workspace's canonical path, or "" when the catalog is empty.
	function currentWorkspace() {
		var select = el("workspace");
		var option =
			select.selectedIndex >= 0
				? select.options[select.selectedIndex]
				: undefined;
		return option === undefined ? "" : option.value;
	}
	// Submit is usable only when a run is not active and a workspace is chosen.
	function syncSubmitState() {
		el("submit").disabled = state.running || currentWorkspace() === "";
	}
	function setInputsLocked(locked) {
		[
			"task",
			"workspace",
			"primary-model",
			"lane-left-model",
			"lane-right-model",
		].forEach((id) => {
			el(id).disabled = locked;
		});
		el("cancel").disabled = !locked;
		syncSubmitState();
	}
	function startRun() {
		state.running = true;
		state.runElapsed = 0;
		el("primary-output").textContent = "";
		LANES.forEach(clearLane);
		setInputsLocked(true);
		showRunStatus("running · 0s");
		runTimer = setInterval(() => {
			state.runElapsed += 1;
			showRunStatus("running · " + state.runElapsed + "s");
		}, 1000);
	}
	function endRun(status) {
		state.running = false;
		if (runTimer) {
			clearInterval(runTimer);
			runTimer = null;
		}
		LANES.forEach(stopLaneTimer);
		setInputsLocked(false);
		showRunStatus(status + " · " + state.runElapsed + "s");
	}
	function appendText(target, text) {
		if (text) target.textContent += text;
	}

	// ---- route run events: lane events to their panel, orchestrator to top ----
	function handleEvent(msg) {
		switch (msg.type) {
			case "run/started":
				startRun();
				break;
			case "run/done":
				// A clear completion signal: any lane still running is done.
				LANES.forEach((lane) => {
					if (laneRunning[lane]) finishLane(lane, "done", "done");
				});
				endRun("done");
				break;
			case "run/canceled":
				// The whole run aborted: running lanes wind down to canceled.
				LANES.forEach((lane) => {
					if (laneRunning[lane]) finishLane(lane, "canceled", "canceled");
				});
				endRun("canceled");
				break;
			case "orchestrator/delta":
				appendText(el("primary-output"), msg.text);
				break;
			case "lane/worker/started":
				startLaneTimer(msg.laneId);
				break;
			case "lane/worker/delta":
				appendText(el("lane-" + msg.laneId + "-output"), msg.text);
				break;
			case "lane/worker/done":
				finishLane(msg.laneId, "done", "done");
				break;
			case "lane/worker/error":
				// The reason is logged server-side; the lane just shows its error chip.
				finishLane(msg.laneId, "error", "error");
				break;
		}
	}

	// ---- the run WebSocket: submit and cancel ----
	function openSocket() {
		var proto = location.protocol === "https:" ? "wss://" : "ws://";
		ws = new WebSocket(proto + location.host + "/ws");
		ws.onopen = () => {
			el("conn-status").textContent = "connected";
		};
		ws.onclose = () => {
			el("conn-status").textContent = "disconnected";
		};
		ws.onerror = () => {
			el("conn-status").textContent = "error";
		};
		ws.onmessage = (e) => {
			try {
				handleEvent(JSON.parse(e.data));
			} catch (_) {
				/* ignore malformed */
			}
		};

		el("submit").addEventListener("click", () => {
			if (state.running || !ws || ws.readyState !== 1) return;
			var workspace = currentWorkspace();
			ws.send(
				JSON.stringify({
					type: "submit",
					request: {
						task: el("task").value,
						primaryModel: el("primary-model").value,
						laneModels: {
							left: el("lane-left-model").value,
							right: el("lane-right-model").value,
						},
						workspace: workspace,
					},
				}),
			);
		});

		el("cancel").addEventListener("click", () => {
			if (state.running && ws && ws.readyState === 1) {
				ws.send(JSON.stringify({ type: "cancel" }));
			}
		});
	}

	populateModelLists();
	populateWorkspaceList();
	openSocket();
	syncSubmitState();
})();
