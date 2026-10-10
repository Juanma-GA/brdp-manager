// AACF 3, Part 1: the Records History section starts collapsed on every
// page load and is no longer remembered in the browser (HR1). Scripts that
// read History entries open it with a real click on its toggle: on each
// page load, the first time the toggle appears collapsed it is clicked once
// (a script that collapses it afterwards keeps it collapsed). Call before
// the first page.goto().
export async function openHistoryOnEachLoad(page) {
  await page.addInitScript(() => {
    let clicked = false;
    const tryOpen = () => {
      if (clicked) return;
      const toggle = document.querySelector('[data-testid="history-toggle"]');
      if (toggle && toggle.getAttribute("aria-expanded") === "false") {
        clicked = true;
        toggle.click();
      }
    };
    const start = () => new MutationObserver(tryOpen).observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}
