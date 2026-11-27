(() => {
	let theme;
	try {
		theme = localStorage.getItem("rothcold-theme");
	} catch {
		return;
	}
	if (theme === "light" || theme === "dark") {
		document.documentElement.dataset.theme = theme;
	}
})();
