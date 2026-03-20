--
-- PostgreSQL database dump
--

\restrict j7JFkvdXeYciBrHThITN9dRm5yHRkXXdjanorBn58gl0QXsqaNxb3bZ8rnLIYzq

-- Dumped from database version 18.3 (Homebrew)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: curators; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.curators (id, name, bio, image_url, instagram, created_at) FROM stdin;
3	Lucas Moon	loves the beach	http://localhost:3000/lucas-moon.jpg	lucasmoon	2026-03-12 21:05:26.007521-07
\.


--
-- Data for Name: curator_submissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.curator_submissions (id, curator_id, title, artist, spotify_url, theme, week_number, curator_note, submitted_at) FROM stdin;
1	3	the chain	Fleetwood MAc	https://open.spotify.com/track/77oU2rjC5XbjQfNe3bD6so?si=4be61a0b6e8b4c75	great songs for fun	1	great song for fun	2026-03-12 22:17:46.036472-07
\.


--
-- Data for Name: genres; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.genres (id, name) FROM stdin;
1	Rock
2	Pop
3	Punk
4	Country
\.


--
-- Data for Name: songs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.songs (id, title, artist, url, genre_id, curator_id, created_at) FROM stdin;
1	The Chain	Fleetwood Mac	\N	\N	3	2026-03-12 21:18:30.428468
\.


--
-- Name: curator_submissions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.curator_submissions_id_seq', 1, true);


--
-- Name: curators_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.curators_id_seq', 3, true);


--
-- Name: genres_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.genres_id_seq', 4, true);


--
-- Name: songs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.songs_id_seq', 1, true);


--
-- PostgreSQL database dump complete
--

\unrestrict j7JFkvdXeYciBrHThITN9dRm5yHRkXXdjanorBn58gl0QXsqaNxb3bZ8rnLIYzq

