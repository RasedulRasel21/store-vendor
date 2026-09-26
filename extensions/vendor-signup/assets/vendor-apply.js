/* Sends the application without leaving the page, and puts each complaint next to the
   field it belongs to. If any of this fails the form is still an ordinary form: the
   browser posts it and the app proxy answers with its own page. */
(function () {
  function setup(root) {
    if (root.dataset.svReady) return;
    root.dataset.svReady = "1";

    var form = root.querySelector("[data-sv-form]");
    var banner = root.querySelector("[data-sv-banner]");
    var done = root.querySelector("[data-sv-done]");
    var button = root.querySelector("[data-sv-submit]");
    var started = root.querySelector("[data-sv-started]");
    if (!form) return;

    // Filled in once the page is up: a form sent faster than anyone could read it is
    // almost certainly not a person.
    if (started) started.value = String(Date.now());

    function clearErrors() {
      if (banner) {
        banner.hidden = true;
        banner.textContent = "";
      }
      root.querySelectorAll("[data-sv-error]").forEach(function (el) {
        el.hidden = true;
        el.textContent = "";
      });
      form.querySelectorAll("[aria-invalid]").forEach(function (el) {
        el.removeAttribute("aria-invalid");
        el.removeAttribute("aria-describedby");
      });
    }

    function showErrors(errors) {
      var first = null;
      Object.keys(errors).forEach(function (field) {
        var el = root.querySelector('[data-sv-error="' + field + '"]');
        var input = form.elements[field];
        if (el) {
          el.textContent = errors[field];
          el.hidden = false;
          if (!el.id) el.id = "sv-err-" + field;
        }
        if (input && input.setAttribute) {
          input.setAttribute("aria-invalid", "true");
          if (el) input.setAttribute("aria-describedby", el.id);
          if (!first) first = input;
        }
      });
      if (first && first.focus) {
        first.focus();
        if (first.scrollIntoView) first.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    function showBanner(message) {
      if (!banner) return;
      banner.textContent = message;
      banner.hidden = false;
      banner.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    form.addEventListener("submit", function (event) {
      if (!window.fetch || !window.FormData) return;
      event.preventDefault();
      clearErrors();

      var body = new FormData(form);
      body.set("format", "json");
      if (button) {
        button.disabled = true;
        button.dataset.svLabel = button.textContent;
        button.textContent = "Sending…";
      }

      fetch(form.getAttribute("action"), {
        method: "POST",
        body: body,
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          return response.json().catch(function () {
            return null;
          });
        })
        .then(function (result) {
          if (result && result.ok) {
            form.hidden = true;
            if (done) {
              done.hidden = false;
              done.scrollIntoView({ block: "center", behavior: "smooth" });
            }
            return;
          }
          if (result && result.errors) {
            showErrors(result.errors);
          } else {
            showBanner((result && result.error) || "That couldn't be sent. Try again in a moment.");
          }
        })
        .catch(function () {
          showBanner("That couldn't be sent. Check your connection and try again.");
        })
        .finally(function () {
          if (button) {
            button.disabled = false;
            if (button.dataset.svLabel) button.textContent = button.dataset.svLabel;
          }
        });
    });
  }

  function init() {
    document.querySelectorAll("[data-sv-apply]").forEach(setup);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // The theme editor rebuilds a block when its settings change.
  document.addEventListener("shopify:section:load", init);
  document.addEventListener("shopify:block:select", init);
})();
