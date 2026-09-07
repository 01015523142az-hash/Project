-- v561: zip code is optional on a dialer list import
--
-- v536 seeded seven mandatory fields, zip among them, and the admin import
-- screen refuses to import until every mandatory field is mapped
-- (missingRequired() in dialer/admin.html). Zip earns its place in that list
-- least of the seven: nothing in the dial path reads it. The calling-hours
-- gate takes its zone from the NUMBER's area code, and the caller-ID picker
-- matches on state, so a file with no zip column is perfectly dialable and
-- was being turned away at the door for a field the dialer never consults.
--
-- Left mandatory: first name, last name, phone, address, city, state -- the
-- ones an agent reads aloud on the call or the engine actually uses.
update dialer_field_defs
   set is_required = false
 where key = 'zip';
