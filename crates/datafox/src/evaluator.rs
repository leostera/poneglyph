use crate::{Atom, Clause, Error, Query, Result, Storage, Substitution, Unifier, Universe, Value};

pub type SubstitutionStream<'a> = Box<dyn Iterator<Item = Result<Substitution>> + 'a>;

/// Query-only evaluator over a snapshot universe.
pub struct Evaluator;

impl Evaluator {
    pub fn query<'a, S: Storage>(
        universe: &'a Universe<S>,
        atom: &'a Atom,
    ) -> Result<SubstitutionStream<'a>> {
        let pattern = atom_to_pattern(atom);
        let atom = atom.clone();
        let tuples = universe.get_facts_matching(&atom.predicate, pattern)?;

        Ok(Box::new(tuples.filter_map(move |tuple| match tuple {
            Ok(tuple) => match Unifier::match_atom(&Substitution::new(), &atom, &tuple) {
                Ok(Some(substitution)) => Some(Ok(substitution)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            },
            Err(error) => Some(Err(error)),
        })))
    }

    pub fn evaluate<'a, S: Storage>(
        universe: &'a Universe<S>,
        query: &'a Query,
    ) -> Result<SubstitutionStream<'a>> {
        match query {
            Query::Single(atom) => Self::query(universe, atom),
            Query::Multi(clauses) => {
                if clauses
                    .iter()
                    .any(|clause| matches!(clause, Clause::Negated(_)))
                {
                    return Err(Error::UnsupportedNegation);
                }
                if clauses
                    .iter()
                    .any(|clause| matches!(clause, Clause::Builtin { .. }))
                {
                    return Err(Error::UnsupportedBuiltin);
                }
                Err(Error::UnsupportedMultiQuery)
            }
        }
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

#[cfg(test)]
mod tests {
    use crate::{Clause, Evaluator, InMemoryStorage, Query, Result, Universe, Value, parse_query};

    #[test]
    fn evaluator_streams_single_goal_matches() -> Result<()> {
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

        let results = Evaluator::query(&universe, &atom)?.collect::<crate::Result<Vec<_>>>()?;

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].lookup("Album"),
            Some(&Value::from("spotify:album:2112"))
        );
        Ok(())
    }

    #[test]
    fn evaluator_can_run_parsed_single_goal_queries() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![vec![Value::integer(1), Value::integer(2)]],
        )]));
        let query = parse_query("edge(X, 2)")?;

        let results = Evaluator::evaluate(&universe, &query)?.collect::<crate::Result<Vec<_>>>()?;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].lookup("X"), Some(&Value::integer(1)));
        Ok(())
    }

    #[test]
    fn evaluator_rejects_multi_goal_queries_for_now() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::new());
        let query = Query::multi(vec![
            Clause::atom(crate::atom!(
                "edge",
                vec![crate::var!("X"), crate::var!("Y")]
            )),
            Clause::atom(crate::atom!(
                "edge",
                vec![crate::var!("Y"), crate::var!("Z")]
            )),
        ])?;

        let error = match Evaluator::evaluate(&universe, &query) {
            Ok(_) => panic!("expected unsupported multi query"),
            Err(error) => error,
        };

        assert_eq!(error, crate::Error::UnsupportedMultiQuery);
        Ok(())
    }

    #[test]
    fn evaluator_rejects_negated_clauses_for_now() -> Result<()> {
        let universe = Universe::new(InMemoryStorage::new());
        let query = Query::multi(vec![Clause::negated(crate::atom!(
            "edge",
            vec![crate::var!("X"), crate::var!("Y")]
        ))])?;

        let error = match Evaluator::evaluate(&universe, &query) {
            Ok(_) => panic!("expected unsupported negation"),
            Err(error) => error,
        };

        assert_eq!(error, crate::Error::UnsupportedNegation);
        Ok(())
    }
}
