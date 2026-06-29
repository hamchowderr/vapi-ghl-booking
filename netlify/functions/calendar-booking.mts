// netlify/functions/calendar-booking.mts
// Netlify adapter for the `calendarBooking` tool handler (book / reschedule).
// Logic lives in ../../api/calendar-booking.ts (shared with Vercel).
import { POST } from "../../api/calendar-booking.js";

export default (req: Request): Promise<Response> => POST(req);

export const config = { path: "/api/calendar-booking" };
