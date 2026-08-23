(function () {
  "use strict";

  var card = document.getElementById("status-card");
  var messageEl = document.getElementById("status-message");
  var updatedAtEl = document.getElementById("updated-at");
  var toggleButton = document.getElementById("toggle-status");

  var isDown = false;

  function formatTime(date) {
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return (
      pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
    );
  }

  function render() {
    var label = isDown ? "down" : "ok";
    var message = isDown
      ? "We're experiencing an incident — some systems may be affected."
      : "All systems operational.";

    card.dataset.status = label;
    messageEl.textContent = message;
    toggleButton.textContent = isDown ? "Resolve incident" : "Simulate an incident";
    toggleButton.setAttribute("aria-pressed", isDown ? "true" : "false");
    updatedAtEl.textContent = formatTime(new Date());
  }

  function toggleStatus() {
    isDown = !isDown;
    render();
  }

  if (card && messageEl && updatedAtEl && toggleButton) {
    toggleButton.addEventListener("click", toggleStatus);
    render();
  }
})();
