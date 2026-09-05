/**
 * MONEXA · CYBERNETIC POPUP & NOTIFICATION ENGINE
 * Reemplazo ultra-futurista de alert(), confirm() y prompt() con estética Sci-Fi HUD.
 */

// Crear contenedor de Toasts si no existe
function getToastContainer() {
  let container = document.getElementById("cyber-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "cyber-toast-container";
    container.className = "cyber-toast-container";
    document.body.appendChild(container);
  }
  return container;
}

const TYPE_CONFIG = {
  success: {
    icon: "✓",
    badge: "SISTEMA · ÉXITO",
    colorClass: "toast-success",
    defaultTitle: "Operación Exitosa"
  },
  info: {
    icon: "⚡",
    badge: "TELEMETRÍA · ENJAMBRE",
    colorClass: "toast-info",
    defaultTitle: "Aviso de Enjambre"
  },
  warn: {
    icon: "⚠",
    badge: "ALERTA · CONTROL",
    colorClass: "toast-warn",
    defaultTitle: "Advertencia"
  },
  error: {
    icon: "✕",
    badge: "ERROR · CRÍTICO",
    colorClass: "toast-error",
    defaultTitle: "Error del Sistema"
  }
};

/**
 * Notificación flotante Toast ultra-futurista con barra de progreso luminosa y auto-cierre.
 */
export function cyberNotify(message, options = {}) {
  const type = options.type || "info";
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.info;
  const title = options.title || cfg.defaultTitle;
  const duration = options.duration || 4500;
  const icon = options.icon || cfg.icon;

  const container = getToastContainer();

  const toast = document.createElement("div");
  toast.className = `cyber-toast ${cfg.colorClass}`;

  toast.innerHTML = `
    <div class="toast-ambient-glow"></div>
    <div class="toast-content">
      <div class="toast-icon-wrap">
        <span class="toast-icon-ring"></span>
        <span class="toast-icon">${icon}</span>
      </div>
      <div class="toast-body">
        <div class="toast-badge">${cfg.badge}</div>
        <h4 class="toast-title">${escapeHtml(title)}</h4>
        <p class="toast-message">${escapeHtml(String(message))}</p>
      </div>
      <button class="toast-close-btn" title="Cerrar">✕</button>
    </div>
    <div class="toast-progress-bar" style="animation-duration: ${duration}ms"></div>
  `;

  const closeBtn = toast.querySelector(".toast-close-btn");
  let timer;

  const remove = () => {
    if (toast.classList.contains("toast-closing")) return;
    toast.classList.add("toast-closing");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 320);
  };

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    remove();
  });

  // Pausar auto-dismiss al pasar el cursor
  toast.addEventListener("mouseenter", () => {
    clearTimeout(timer);
    const bar = toast.querySelector(".toast-progress-bar");
    if (bar) bar.style.animationPlayState = "paused";
  });

  toast.addEventListener("mouseleave", () => {
    const bar = toast.querySelector(".toast-progress-bar");
    if (bar) bar.style.animationPlayState = "running";
    timer = setTimeout(remove, 1500);
  });

  container.appendChild(toast);
  timer = setTimeout(remove, duration);

  return { dismiss: remove };
}

/**
 * Diálogo modal futurista interactivo (Alert, Confirm o Prompt).
 */
export function cyberDialog({
  title = "Autorización de Enjambre",
  badge = "CONFIRMACIÓN · SEGURIDAD",
  message = "¿Deseas continuar con esta acción?",
  type = "info",
  showInput = false,
  inputPlaceholder = "",
  inputValue = "",
  confirmText = "Aceptar",
  cancelText = "Cancelar",
  isAlert = false
} = {}) {
  return new Promise((resolve) => {
    const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.info;

    const overlay = document.createElement("div");
    overlay.className = "cyber-dialog-overlay";

    overlay.innerHTML = `
      <div class="cyber-dialog-card ${cfg.colorClass}">
        <div class="dialog-corner corner-tl"></div>
        <div class="dialog-corner corner-tr"></div>
        <div class="dialog-corner corner-bl"></div>
        <div class="dialog-corner corner-br"></div>
        
        <div class="dialog-header">
          <div class="dialog-badge">${badge}</div>
          <h3 class="dialog-title">
            <span class="dialog-icon">${cfg.icon}</span>
            ${escapeHtml(title)}
          </h3>
        </div>

        <div class="dialog-body">
          <p class="dialog-message">${escapeHtml(String(message))}</p>
          ${showInput ? `
            <div class="dialog-input-wrap">
              <input type="text" class="dialog-input" placeholder="${escapeHtml(inputPlaceholder)}" value="${escapeHtml(inputValue)}" />
            </div>
          ` : ""}
        </div>

        <div class="dialog-actions">
          ${!isAlert ? `
            <button class="dialog-btn dialog-btn-cancel">${escapeHtml(cancelText)}</button>
          ` : ""}
          <button class="dialog-btn dialog-btn-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector(".dialog-input");
    const confirmBtn = overlay.querySelector(".dialog-btn-confirm");
    const cancelBtn = overlay.querySelector(".dialog-btn-cancel");

    if (input) {
      setTimeout(() => input.focus(), 80);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          cleanup(input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cleanup(null);
        }
      });
    } else {
      setTimeout(() => confirmBtn.focus(), 80);
    }

    function cleanup(result) {
      overlay.classList.add("closing");
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 250);
    }

    confirmBtn.addEventListener("click", () => {
      cleanup(showInput ? (input ? input.value : "") : true);
    });

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        cleanup(showInput ? null : false);
      });
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup(showInput ? null : false);
      }
    });

    const onKey = (e) => {
      if (e.key === "Escape") {
        window.removeEventListener("keydown", onKey);
        cleanup(showInput ? null : false);
      }
    };
    window.addEventListener("keydown", onKey);
  });
}

/**
 * Reemplazo futurista de window.alert
 */
export function cyberAlert(message, title = "Aviso de Enjambre") {
  return cyberNotify(message, {
    title,
    type: "info",
    duration: 5000
  });
}

/**
 * Reemplazo futurista de window.confirm
 */
export function cyberConfirm(message, title = "¿Confirmar Operación?") {
  return cyberDialog({
    title,
    message,
    type: "warn",
    badge: "ACCIÓN DE CONTROL",
    confirmText: "Confirmar",
    cancelText: "Descartar"
  });
}

/**
 * Reemplazo futurista de window.prompt
 */
export function cyberPrompt(message, defaultValue = "", title = "Entrada Requerida") {
  return cyberDialog({
    title,
    message,
    type: "info",
    badge: "ENTRADA DE DATOS",
    showInput: true,
    inputValue: defaultValue,
    inputPlaceholder: "Escribe aquí...",
    confirmText: "Aceptar",
    cancelText: "Cancelar"
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Inyección global para que cualquier script pueda invocarlo
if (typeof window !== "undefined") {
  window.cyberNotify = cyberNotify;
  window.cyberAlert = cyberAlert;
  window.cyberConfirm = cyberConfirm;
  window.cyberPrompt = cyberPrompt;
  window.cyberDialog = cyberDialog;
}
