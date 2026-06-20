import pytest

from app import identity


def test_canonicalization_idempotent():
    smi = "C1=CC=C(C=C1)S(=O)(=O)N"  # benzenesulfonamide, non-canonical input
    once = identity.canonicalize(smi)
    twice = identity.canonicalize(once)
    assert once == twice


def test_inchikey_stable_across_spellings():
    a = identity.inchikey("CC(=O)Oc1ccccc1C(=O)O")
    b = identity.inchikey("O=C(C)Oc1ccccc1C(O)=O")
    assert a == b
    assert len(a) == 27 and a.count("-") == 2  # standard InChIKey shape


def test_invalid_smiles_raises_typed_error():
    with pytest.raises(identity.InvalidSmilesError):
        identity.canonicalize("not_a_smiles_%%%")
    with pytest.raises(identity.InvalidSmilesError):
        identity.inchikey("")


def test_resolve_dedups_on_inchikey():
    a = identity.resolve("CC(=O)Oc1ccccc1C(=O)O")
    b = identity.resolve("O=C(C)Oc1ccccc1C(O)=O")  # same molecule, different spelling
    assert a.inchikey == b.inchikey
    assert a.compound_id == b.compound_id  # same id assigned
