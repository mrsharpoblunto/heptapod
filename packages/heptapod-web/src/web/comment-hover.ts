export function createCommentHover() {
  let active: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Map<string, Set<() => void>>();

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const show = (id: string | null) => {
    cancel();
    if (active === id) return;
    const previous = active;
    active = id;
    if (previous !== null) listeners.get(previous)?.forEach((listener) => listener());
    if (id !== null) listeners.get(id)?.forEach((listener) => listener());
  };
  return {
    isActive: (id: string) => active === id,
    subscribe: (id: string, listener: () => void) => {
      let subscribers = listeners.get(id);
      if (!subscribers) { subscribers = new Set(); listeners.set(id, subscribers); }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(id);
      };
    },
    show,
    leave: (id: string) => {
      if (active !== id) return;
      cancel();
      timer = setTimeout(() => show(null), 400);
    },
    clear: () => show(null),
  };
}
