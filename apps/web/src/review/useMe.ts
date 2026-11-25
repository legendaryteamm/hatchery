import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "../api";

/** The signed-in reviewer, or null when signed out (401). */
export function useMe() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api
      .get<Me>("/review/me")
      .then(setMe)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setMe(null)));
  }, []);
  return me;
}
