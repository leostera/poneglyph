use regex::Regex;
use tokio::sync::mpsc;
use tracing::debug;

use crate::{Atom, Clause, Error, Query, Result, Storage, Substitution, Unifier, Universe, Value};

pub type SubstitutionStream = mpsc::Receiver<Result<Substitution>>;

const DEFAULT_STREAM_BUFFER: usize = 64;

/// Query-only evaluator over a snapshot universe.
pub struct Evaluator;

impl Evaluator {
    pub async fn query<S>(universe: &Universe<S>, atom: &Atom) -> Result<SubstitutionStream>
    where
        S: Storage + Clone + Send + Sync + 'static,
    {
        Self::evaluate_query(universe.clone(), Query::single(atom.clone())).await
    }

    pub async fn evaluate<S>(universe: &Universe<S>, query: &Query) -> Result<SubstitutionStream>
    where
        S: Storage + Clone + Send + Sync + 'static,
    {
        Self::evaluate_query(universe.clone(), query.clone()).await
    }

    async fn evaluate_query<S>(universe: Universe<S>, query: Query) -> Result<SubstitutionStream>
    where
        S: Storage + Clone + Send + Sync + 'static,
    {
        match &query {
            Query::Single(_) | Query::Multi(_) => {}
        }

        let (tx, rx) = mpsc::channel(DEFAULT_STREAM_BUFFER);
        tokio::spawn(async move {
            debug!("starting query evaluation task");
            let result = match query {
                Query::Single(atom) => {
                    Self::evaluate_positive_clauses(&universe, vec![Clause::atom(atom)]).await
                }
                Query::Multi(clauses) => Self::evaluate_positive_clauses(&universe, clauses).await,
            };

            match result {
                Ok(substitutions) => {
                    for substitution in substitutions {
                        if tx.send(Ok(substitution)).await.is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error)).await;
                }
            }
        });

        Ok(rx)
    }

    async fn evaluate_positive_clauses<S>(
        universe: &Universe<S>,
        clauses: Vec<Clause>,
    ) -> Result<Vec<Substitution>>
    where
        S: Storage + Clone + Send + Sync + 'static,
    {
        debug!(clause_count = clauses.len(), "evaluating positive clauses");
        let mut seeds = vec![Substitution::new()];

        for clause in clauses {
            let atom = match clause {
                Clause::Atom(atom) => atom,
                Clause::Negated(_) => return Err(Error::UnsupportedNegation),
                Clause::Builtin { name, args } => {
                    let mut next_seeds = Vec::new();
                    for seed in seeds {
                        if Self::evaluate_builtin_clause(&name, &args, &seed)? {
                            next_seeds.push(seed);
                        }
                    }
                    debug!(
                        builtin = %name,
                        seed_count = next_seeds.len(),
                        "advanced builtin clause evaluation"
                    );
                    seeds = next_seeds;
                    continue;
                }
            };

            let mut next_seeds = Vec::new();
            for seed in seeds {
                let mut matches = Self::query_atom_matches(universe, &atom, &seed).await?;
                next_seeds.append(&mut matches);
            }
            debug!(seed_count = next_seeds.len(), predicate = %atom.predicate, "advanced clause evaluation");
            seeds = next_seeds;
        }

        Ok(seeds)
    }

    fn evaluate_builtin_clause(
        name: &str,
        args: &[crate::Term],
        seed: &Substitution,
    ) -> Result<bool> {
        let [left, right] = args else {
            return Err(Error::BuiltinArityMismatch {
                name: name.to_string(),
                expected: 2,
                found: args.len(),
            });
        };

        let Some(left) = Unifier::ground_term(seed, left) else {
            return Err(Error::UngroundedBuiltin {
                name: name.to_string(),
            });
        };
        let Some(right) = Unifier::ground_term(seed, right) else {
            return Err(Error::UngroundedBuiltin {
                name: name.to_string(),
            });
        };

        match name {
            "eq" => Ok(left == right),
            "gt" => Ok(values_are_ordered_compatibly(&left, &right) && left > right),
            "gte" => Ok(values_are_ordered_compatibly(&left, &right) && left >= right),
            "lt" => Ok(values_are_ordered_compatibly(&left, &right) && left < right),
            "lte" => Ok(values_are_ordered_compatibly(&left, &right) && left <= right),
            "startsWith" => {
                let (haystack, prefix) = string_args(name, &left, &right)?;
                Ok(haystack.starts_with(prefix))
            }
            "endsWith" => {
                let (haystack, suffix) = string_args(name, &left, &right)?;
                Ok(haystack.ends_with(suffix))
            }
            "contains" => {
                let (haystack, needle) = string_args(name, &left, &right)?;
                Ok(haystack.contains(needle))
            }
            "matchesRegex" => {
                let (haystack, pattern) = string_args(name, &left, &right)?;
                let regex = Regex::new(pattern).map_err(|_| Error::BuiltinTypeMismatch {
                    name: name.to_string(),
                    expected: "a valid regex pattern as the second string argument".to_string(),
                })?;
                Ok(regex.is_match(haystack))
            }
            "before" => Ok(values_are_ordered_compatibly(&left, &right) && left < right),
            "after" => Ok(values_are_ordered_compatibly(&left, &right) && left > right),
            _ => Err(Error::UnsupportedBuiltin {
                name: name.to_string(),
            }),
        }
    }

    async fn query_atom_matches<S>(
        universe: &Universe<S>,
        atom: &Atom,
        seed: &Substitution,
    ) -> Result<Vec<Substitution>>
    where
        S: Storage + Clone + Send + Sync + 'static,
    {
        let pattern = atom_to_pattern(&seed.apply_to_atom(atom));
        let mut tuples = universe
            .get_facts_matching(&atom.predicate, pattern)
            .await?;
        let mut substitutions = Vec::new();

        while let Some(tuple) = tuples.recv().await {
            let tuple = tuple?;
            if let Some(substitution) = Unifier::match_atom(seed, atom, &tuple)? {
                substitutions.push(substitution);
            }
        }

        debug!(
            match_count = substitutions.len(),
            "matched atom against storage"
        );
        Ok(substitutions)
    }
}

fn atom_to_pattern(atom: &Atom) -> Vec<Option<Value>> {
    atom.args
        .iter()
        .map(|term| match term {
            crate::Term::Const(value) => Some(value.clone()),
            crate::Term::Var(_) | crate::Term::Wildcard => None,
        })
        .collect()
}

fn values_are_ordered_compatibly(left: &Value, right: &Value) -> bool {
    matches!(
        (left, right),
        (Value::Integer(_), Value::Integer(_)) | (Value::String(_), Value::String(_))
    )
}

fn string_args<'a>(name: &str, left: &'a Value, right: &'a Value) -> Result<(&'a str, &'a str)> {
    match (left, right) {
        (Value::String(left), Value::String(right)) => Ok((left, right)),
        _ => Err(Error::BuiltinTypeMismatch {
            name: name.to_string(),
            expected: "two string arguments".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use crate::{Clause, Evaluator, InMemoryStorage, Query, Result, Universe, Value, parse_query};

    async fn collect_results(
        mut stream: crate::SubstitutionStream,
    ) -> crate::Result<Vec<crate::Substitution>> {
        let mut results = Vec::new();
        while let Some(result) = stream.recv().await {
            results.push(result?);
        }
        Ok(results)
    }

    #[tokio::test]
    async fn evaluator_streams_single_goal_matches() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "spotify:displayName".to_string(),
            vec![
                vec![Value::from("spotify:album:2112"), Value::from("2112")],
                vec![Value::from("spotify:album:signals"), Value::from("Signals")],
            ],
        )]));
        let atom = crate::atom!(
            "spotify:displayName",
            vec![crate::var!("Album"), crate::lit!(Value::from("2112"))]
        );

        let results = collect_results(Evaluator::query(&universe, &atom).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Album"),
            Some(&Value::from("spotify:album:2112"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_can_run_parsed_single_goal_queries() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![vec![Value::integer(1), Value::integer(2)]],
        )]));
        let query = parse_query("edge(X, 2)")?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].lookup("X"), Some(&Value::integer(1)));
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_streams_multi_goal_conjunctive_matches() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([
            (
                "spotify:byArtist".to_string(),
                vec![
                    vec![
                        Value::from("spotify:album:2112"),
                        Value::from("spotify:artist:rush"),
                    ],
                    vec![
                        Value::from("spotify:album:fragile"),
                        Value::from("spotify:artist:yes"),
                    ],
                ],
            ),
            (
                "spotify:displayName".to_string(),
                vec![
                    vec![Value::from("spotify:artist:rush"), Value::from("Rush")],
                    vec![Value::from("spotify:artist:yes"), Value::from("Yes")],
                ],
            ),
        ]));
        let query = Query::multi(vec![
            Clause::atom(crate::atom!(
                "spotify:byArtist",
                vec![crate::var!("Album"), crate::var!("Artist")]
            )),
            Clause::atom(crate::atom!(
                "spotify:displayName",
                vec![crate::var!("Artist"), crate::lit!(Value::from("Rush"))]
            )),
        ])?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Album"),
            Some(&Value::from("spotify:album:2112"))
        );
        assert_eq!(
            results[0].lookup("Artist"),
            Some(&Value::from("spotify:artist:rush"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_streams_empty_results_for_unsatisfied_multi_goal_queries() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![
                vec![Value::integer(1), Value::integer(2)],
                vec![Value::integer(2), Value::integer(3)],
            ],
        )]));
        let query = Query::multi(vec![
            Clause::atom(crate::atom!(
                "edge",
                vec![crate::var!("X"), crate::var!("Y")]
            )),
            Clause::atom(crate::atom!(
                "edge",
                vec![crate::var!("Y"), crate::lit!(Value::integer(99))]
            )),
        ])?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert!(results.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_rejects_negated_clauses_for_now() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::new());
        let query = Query::multi(vec![Clause::negated(crate::atom!(
            "edge",
            vec![crate::var!("X"), crate::var!("Y")]
        ))])?;

        let error = match Evaluator::evaluate(&universe, &query).await {
            Ok(mut stream) => match stream.recv().await {
                Some(Err(error)) => error,
                other => panic!("expected unsupported negation, got {other:?}"),
            },
            Err(error) => error,
        };

        assert_eq!(error, crate::Error::UnsupportedNegation);
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_filters_results_with_infix_comparison_builtins() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "gcal:startedAt".to_string(),
            vec![
                vec![
                    Value::string("gcal:event:one"),
                    Value::string("2026-01-01 22:00:00"),
                ],
                vec![
                    Value::string("gcal:event:two"),
                    Value::string("2026-01-03 08:00:00"),
                ],
            ],
        )]));
        let query = parse_query(
            "gcal:startedAt(Event, Start), Start > \"2026-01-01\", Start < \"2026-01-02\"",
        )?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Event"),
            Some(&Value::string("gcal:event:one"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_supports_equality_builtins() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![
                vec![Value::integer(1), Value::integer(1)],
                vec![Value::integer(1), Value::integer(2)],
            ],
        )]));
        let query = parse_query("edge(X, Y), X = Y")?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].lookup("X"), Some(&Value::integer(1)));
        assert_eq!(results[0].lookup("Y"), Some(&Value::integer(1)));
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_supports_named_string_builtins() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "spotify:displayName".to_string(),
            vec![
                vec![Value::string("spotify:artist:rush"), Value::string("Rush")],
                vec![Value::string("spotify:artist:yes"), Value::string("Yes")],
            ],
        )]));
        let query = parse_query(
            r#"spotify:displayName(Artist, Name), startsWith(Name, "Ru"), endsWith(Name, "sh"), contains(Name, "us"), matchesRegex(Name, "^R.*h$")"#,
        )?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Artist"),
            Some(&Value::string("spotify:artist:rush"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_supports_temporal_alias_builtins() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "gcal:startedAt".to_string(),
            vec![
                vec![
                    Value::string("gcal:event:one"),
                    Value::string("2026-01-01 22:00:00"),
                ],
                vec![
                    Value::string("gcal:event:two"),
                    Value::string("2026-01-03 08:00:00"),
                ],
            ],
        )]));
        let query = parse_query(
            r#"gcal:startedAt(Event, Start), after(Start, "2026-01-01"), before(Start, "2026-01-02")"#,
        )?;

        let results = collect_results(Evaluator::evaluate(&universe, &query).await?).await?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Event"),
            Some(&Value::string("gcal:event:one"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_requires_ground_builtin_arguments() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::new());
        let query = Query::multi(vec![Clause::builtin(
            "gt",
            vec![
                crate::var!("Start"),
                crate::lit!(Value::string("2026-01-01")),
            ],
        )])?;

        let error = match Evaluator::evaluate(&universe, &query).await {
            Ok(mut stream) => match stream.recv().await {
                Some(Err(error)) => error,
                other => panic!("expected ungrounded builtin error, got {other:?}"),
            },
            Err(error) => error,
        };

        assert_eq!(
            error,
            crate::Error::UngroundedBuiltin {
                name: "gt".to_string(),
            }
        );
        Ok(())
    }

    #[tokio::test]
    async fn evaluator_rejects_unknown_builtins() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::new());
        let query = Query::multi(vec![Clause::builtin(
            "bogusBuiltin",
            vec![
                crate::lit!(Value::string("hello")),
                crate::lit!(Value::string("ell")),
            ],
        )])?;

        let error = match Evaluator::evaluate(&universe, &query).await {
            Ok(mut stream) => match stream.recv().await {
                Some(Err(error)) => error,
                other => panic!("expected unsupported builtin error, got {other:?}"),
            },
            Err(error) => error,
        };

        assert_eq!(
            error,
            crate::Error::UnsupportedBuiltin {
                name: "bogusBuiltin".to_string(),
            }
        );
        Ok(())
    }
}
