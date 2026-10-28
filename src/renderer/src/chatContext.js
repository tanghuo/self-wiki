import { createContext } from "react";
import { request } from "./api.js";

export const ChatContext = createContext(null);
export const post = (url, body = {}) => request(`/api/chat/${url}`, { method: "POST", body: JSON.stringify(body) });
