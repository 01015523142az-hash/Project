-- v563: the area-code table as a real table, and the phone rows that were
--        never being created
--
-- TWO PROBLEMS, ONE CAUSE: nothing has been creating dialer_contact_phones
-- rows since v548 introduced them.
--
--   v548 backfilled the table once, as part of its own migration, and left
--   no trigger and no import-side insert behind. Every contact loaded since
--   has ZERO phone rows. dialer_next_number returns nothing for those
--   contacts, dialer-call-control falls back to dialer_contacts.phone_e164,
--   and the alternates a file supplied as Ph#2..Ph#10 were mapped, stored in
--   contact_fields, shown in the profile panel -- and never dialled once.
--
--   v562 makes that gap load-bearing: rotating through a contact's numbers
--   is meaningless when the contact has exactly one row. This script creates
--   the missing rows, and both import paths now create them going forward.
--
-- WHY THE TABLE, having twice argued the code should carry it: v560 inlined
-- the area-code list into a migration, and this script needs it again for
-- the alternates it is about to create. A third hand-placed copy is how a
-- table like this drifts. The import paths still carry their own copy so a
-- dialable list never depends on a round trip -- that argument has not
-- changed -- but SQL now has one authoritative copy instead of one per
-- migration, and dialer_timezone_for_number() is the only thing that reads
-- it. Seeded from dialer/admin.html rather than retyped.

-- -------------------------------------------------------------------------
-- 1. The table, and the one function that reads it.
-- -------------------------------------------------------------------------
create table if not exists dialer_npa_timezones (
  npa text primary key check (npa ~ '^[2-9][0-9]{2}$'),
  tz  text not null
);

comment on table dialer_npa_timezones is
  'NANP area code -> IANA zone. The calling-hours gate needs the zone of the number, and US portability is confined to the same rate centre, so the area code carries it. Mirrors the copy in dialer/admin.html and dialer-list-import, which resolve inline at import.';

alter table dialer_npa_timezones enable row level security;

drop policy if exists "dialer_npa_timezones: staff select" on dialer_npa_timezones;
create policy "dialer_npa_timezones: staff select" on dialer_npa_timezones
  for select to authenticated using (true);

grant select on dialer_npa_timezones to authenticated;
grant select, insert, update, delete on dialer_npa_timezones to service_role;

insert into dialer_npa_timezones (npa, tz)
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
on conflict (npa) do update set tz = excluded.tz;

-- phone_e164 is normalised to '+1XXXXXXXXXX' by toE164 in both import paths,
-- so the area code is exactly characters 3-5. Anything shaped differently is
-- not a NANP number and resolves to null, which leaves it undialable -- the
-- correct conservative answer rather than a guess.
create or replace function dialer_timezone_for_number(p_phone text)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select t.tz
    from dialer_npa_timezones t
   where length(p_phone) = 12
     and left(p_phone, 2) = '+1'
     and t.npa = substr(p_phone, 3, 3);
$fn$;

grant execute on function dialer_timezone_for_number(text) to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. The rank-1 rows: every contact's primary number.
--    Mirrors v548's backfill, re-run because contacts kept arriving after it.
-- -------------------------------------------------------------------------
insert into dialer_contact_phones
  (contact_id, rank, label, phone_e164, status, attempt_count, last_attempt_at,
   last_outcome, next_attempt_at, phone_valid, phone_line_type, timezone, state)
select c.id, 1, 'Phone number', c.phone_e164,
       case when c.status in ('retired', 'suppressed', 'invalid') then 'exhausted' else 'new' end,
       coalesce(c.attempt_count, 0), c.last_attempt_at, c.last_outcome,
       c.next_attempt_at, c.phone_valid, c.phone_line_type,
       coalesce(c.timezone, dialer_timezone_for_number(c.phone_e164)), c.state
  from dialer_contacts c
 where c.phone_e164 is not null
on conflict (contact_id, phone_e164) do nothing;

-- -------------------------------------------------------------------------
-- 3. Ranks 2..10, from the phone_2..phone_10 the mapper already stored in
--    contact_fields. These are the numbers v562 exists to rotate through.
--
--    Each carries its OWN zone, resolved from its OWN area code: a seller's
--    second line is routinely in a different state from their first, and
--    dialer-call-control reads phoneRow.timezone before the contact's, so
--    inheriting the primary's zone would gate the alternate on the wrong
--    clock.
-- -------------------------------------------------------------------------
insert into dialer_contact_phones (contact_id, rank, label, phone_e164, timezone)
select c.id,
       (regexp_replace(k, '\D', '', 'g'))::smallint as rank,
       'Ph#' || regexp_replace(k, '\D', '', 'g') as label,
       norm.e164,
       dialer_timezone_for_number(norm.e164)
  from dialer_contacts c
  cross join lateral jsonb_object_keys(c.contact_fields) k
  cross join lateral (
    select case
             when length(regexp_replace(c.contact_fields ->> k, '\D', '', 'g')) = 10
               then '+1' || regexp_replace(c.contact_fields ->> k, '\D', '', 'g')
             when length(regexp_replace(c.contact_fields ->> k, '\D', '', 'g')) = 11
              and left(regexp_replace(c.contact_fields ->> k, '\D', '', 'g'), 1) = '1'
               then '+' || regexp_replace(c.contact_fields ->> k, '\D', '', 'g')
           end as e164
  ) norm
 where k ~ '^phone_([2-9]|10)$'
   and coalesce(c.contact_fields ->> k, '') <> ''
   and norm.e164 is not null
   -- Never load an alternate the structural screen would have rejected:
   -- toll-free, premium rate, or a service code. The import paths drop these
   -- on the digits alone and this must not quietly reintroduce them.
   and substr(norm.e164, 3, 3) not in
       ('800','833','844','855','866','877','888','900','976','710','622',
        '500','521','522','523','524','525','526','527','528','529',
        '533','544','566','577','588')
   and substr(norm.e164, 4, 2) <> '11'
   and substr(norm.e164, 6, 1) between '2' and '9'
on conflict (contact_id, phone_e164) do nothing;

-- -------------------------------------------------------------------------
-- 4. Anything still missing a zone, filled from its own area code. Covers
--    rows v548's backfill created before v560 existed.
-- -------------------------------------------------------------------------
update dialer_contact_phones p
   set timezone = dialer_timezone_for_number(p.phone_e164),
       updated_at = now()
 where p.timezone is null
   and dialer_timezone_for_number(p.phone_e164) is not null;
