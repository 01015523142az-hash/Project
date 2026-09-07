-- v560: pre-dial resolution without the per-number charge
--
-- WHAT CHANGED, AND WHY IT IS SAFE
--   An imported contact could not be dialled until Telnyx Number Lookup had
--   resolved its time zone, at $0.0015 a number -- $150 on a 100k list,
--   spent mostly on numbers that would not be dialled for a year. The
--   calling-hours gate needs the zone of the NUMBER, and the number carries
--   it: US portability is confined to the same rate centre, so a ported
--   number keeps its area code and its state. The area code was always the
--   answer; we were buying it back one number at a time.
--
--   Import now resolves it inline (dialer-list-import and the dialer admin
--   screen both carry the same table), so lists land dialable. This script
--   does the same for everything already loaded.
--
-- MORE ACCURATE, NOT JUST CHEAPER. The paid path mapped whole STATES, which
-- put every Florida number in Central -- right for Pensacola, an hour wrong
-- for Miami, and an hour of dialable morning lost on the state that carries
-- the most leads. Per-area-code fixes Florida, El Paso (Mountain, not
-- Central) and Boise (Mountain, not Pacific).
--
-- SPLIT AREA CODES take the majority zone, except where the split is close
-- enough to matter, where they take the WESTERN zone -- the safe error
-- direction. Assuming Central for a number that is really Eastern opens the
-- window at their 10am: late, harmless. The reverse opens it at their 8am.
--
-- NOTHING IS OVERWRITTEN. Only null time zones are filled, so a zone a paid
-- lookup already resolved stands.

-- -------------------------------------------------------------------------
-- 1. Mobile-or-landline, mapped from the file instead of bought.
--
-- Every skip-trace export (DealMachine, PropStream, BatchLeads) carries a
-- phone-type column. Mapping it gives the ranking the paid lookup used to
-- write, off data already in hand. Files without the column are unaffected:
-- multi-number contacts are dialled in the order the file listed them, which
-- is how dialer_next_number has always ordered them.
-- -------------------------------------------------------------------------
insert into dialer_field_defs (key, label, group_name, is_required, column_name, sort_order)
values ('phone_type', 'Phone type (mobile/landline)', 'Contact', false, null, 11)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 2. Backfill. Every contact loaded before this becomes dialable at no cost.
--
-- The table below is the same one the import paths carry inline, generated
-- from the copy in dialer/admin.html rather than retyped. It lives in the
-- code, not in a table, so a dialable list never depends on a round trip;
-- it appears here only to catch up everything loaded before this shipped.
--
-- ONE statement, with the table listed once and shared by both updates
-- through a data-modifying CTE. A temp table would have been the obvious
-- shape, but nothing agrees about what a temp table outlives -- the SQL
-- editor, a migration runner and psql each commit differently -- and a CTE
-- outlives exactly the statement it belongs to, which is what is wanted.
--
-- Grouped by zone rather than listed pair by pair so it reads as the same
-- table the code carries, and so a correction is made in one place.
-- -------------------------------------------------------------------------
with npa_tz as (
  -- Split on any run of non-digits, not a single space: the lists below
  -- are wrapped for reading, so a newline separates two codes exactly as
  -- a space does.
  select regexp_split_to_table(npas, '[^0-9]+') as npa, tz
    from (values
    ('America/New_York',
     '203 475 860 959 302 202 239 305 321 352 386 407 561 656 689 727
      728 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762
      770 912 943 260 317 463 574 765 502 606 859 207 227 240 301 410
      443 667 339 351 413 508 617 774 781 857 978 231 248 269 313 517
      586 616 679 734 810 947 989 603 201 551 609 640 732 848 856 862
      908 973 212 315 332 347 363 516 518 585 607 631 646 680 716 718
      838 845 914 917 929 934 252 336 472 704 743 828 910 919 980 984
      216 220 234 283 326 330 380 419 436 440 513 567 614 740 937 215
      223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803
      839 843 854 864 423 865 802 276 434 540 571 703 757 804 826 948
      304 681'),
    ('America/Chicago',
     '205 251 256 334 659 938 327 479 501 870 448 850 217 224 309 312
      331 447 464 618 630 708 730 773 779 815 847 861 872 219 812 930
      319 515 563 641 712 316 620 785 913 270 364 225 318 337 504 985
      906 218 320 507 612 651 763 924 952 228 601 662 769 314 417 557
      573 636 660 816 975 402 531 701 405 539 572 580 918 605 615 629
      731 901 931 210 214 254 281 325 346 361 409 430 432 469 512 682
      713 726 737 806 817 830 832 903 936 940 945 956 972 979 262 274
      353 414 534 608 715 920'),
    ('America/Denver',
     '303 719 720 970 983 208 986 406 308 505 575 915 385 435 801 307'),
    ('America/Phoenix',
     '480 520 602 623 928'),
    ('America/Los_Angeles',
     '209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619
      626 628 650 657 661 669 707 714 738 747 760 764 805 818 820 831
      840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253
      360 425 509 564'),
    ('America/Anchorage',
     '907'),
    ('Pacific/Honolulu',
     '808'),
    ('America/Puerto_Rico',
     '787 939'),
    ('America/St_Thomas',
     '340')
    ) as g (tz, npas)
),
-- Contacts first. The dial gate falls back to this when a contact has no
-- per-number rows, which is every contact imported since v548.
contacts_filled as (
  update dialer_contacts c
     set timezone = n.tz,
         updated_at = now()
    from npa_tz n
   where c.timezone is null
     and c.phone_e164 is not null
     -- phone_e164 is normalised to '+1XXXXXXXXXX' by toE164 in both import
     -- paths, so the area code is exactly characters 3-5. Anything shaped
     -- differently is not a NANP number and is left alone.
     and length(c.phone_e164) = 12
     and left(c.phone_e164, 2) = '+1'
     and substr(c.phone_e164, 3, 3) = n.npa
  returning 1
)
-- And the per-number rows, which dialer-call-control reads BEFORE the
-- contact's: leaving these null would keep every Ph#2..Ph#10 undialable
-- even once its contact had a zone.
update dialer_contact_phones p
   set timezone = n.tz,
       updated_at = now()
  from npa_tz n
 where p.timezone is null
   and length(p.phone_e164) = 12
   and left(p.phone_e164, 2) = '+1'
   and substr(p.phone_e164, 3, 3) = n.npa;

-- What is left is the residue: an area code this table does not carry. Those
-- rows stay undialable until a lookup resolves them, which is correct -- the
-- Lists tab counts them per list and offers a bounded, paid resolution.
select count(*) filter (where timezone is null) as contacts_without_timezone
  from dialer_contacts
 where status in ('new', 'queued');
